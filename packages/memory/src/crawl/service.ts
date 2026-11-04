/**
 * Crawl service: run orchestration for a KB crawl, host-neutral (no harness / pi imports).
 *
 * The extension tools (crawl_run / crawl_status / crawl_stop / crawl_release, extensions/wolfpack-memory) are thin wrappers
 * over this. A host supplies the pieces that are host-specific (the LLM engine in `runner.run`, the planner in `planner`).
 *
 *   startRun / stopRun / status / listRuns   run lifecycle. Every run is recorded at <runDir>/run.json (state, pid, times,
 *                                            progress snapshot, release record); the in-memory registry is only a cache of
 *                                            abort controllers. A `running` record whose process is gone is reported
 *                                            "interrupted, resumable" after a restart.
 *   buildPlan                                the host's planner hook (drafting a plan), after making the crawl home.
 *   releaseTarget(env)                       hub first (WOLFPACK_HUB_URL), else the KB_OPS inbox, else none.
 *   previewRelease / release                 dry-run review (built locally) and the real, hub-first handoff.
 *   refreshDomains / declaredDomains         declared domains from the KB mirror, else from the hub registry (cached with a TTL,
 *                                            last good kept; requireDomains() fails closed when the registry is unknown).
 *
 * Safety: a start reserves the plan on disk (`.reserve-*`, wx) before the runner runs, so two processes cannot both start it;
 * a release holds an in-process Set + `<runDir>/release.lock` (wx), is refused for runs that are running / interrupted / failed /
 * cancelled, and needs `confirmed: true`. A record counts as running in another process only if host + boot id match, the pid is
 * alive AND its heartbeat (`updatedAt`) is fresh.
 */
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { join, resolve, sep } from "node:path";
import { acquireLock, bootsDiffer, lockHeld, refreshLock, releaseLock, type HeldLock, type LockEnv } from "./lock.js";
import { emitCrawl, type EmitCrawlOptions, type EmitCrawlResult } from "./emit.js";
import { checkHubContributions, emitCrawlToHub, hubTargetFromEnv, listDomainsOnHub, readHubReceipts, redactUrl, scrubSecrets, type HubTarget } from "./hub.js";
import { readPlan } from "./plan.js";
import { DEFAULT_CRAWL_CONCURRENCY, runCrawl, type RunCrawlOptions, type RunCrawlResult } from "./run.js";
import {
  applyProgress,
  denTopicIdsForPlan,
  findIncompleteRuns,
  hasFile,
  listCrawls,
  newRunProgress,
  readIncompleteRun,
  readReleaseState,
  scanCrawlDirs,
  type CrawlEntity,
  type CrawlReleaseState,
  type IncompleteRun,
  type RunProgress,
  type RunRow,
} from "./runs.js";

export const CRAWL_CONCURRENCY_MAX = 32;
export const CONCURRENCY_CHOICES = [5, 8, 12, 16, 24, 32];

/** The engine entry points; hosts / tests replace them (a real run needs an LLM, a real release the KB inbox or hub). */
export interface CrawlRunner {
  run(planFile: string, opts: RunCrawlOptions): Promise<RunCrawlResult>;
  emit(runDir: string, opts: EmitCrawlOptions): EmitCrawlResult | Promise<EmitCrawlResult>;
}

export type RunState = "running" | "done" | "failed" | "gate-failed" | "cancelled";
/** What status reports: a recorded state, or one derived from disk. */
export type RunViewState = RunState | "interrupted" | "running-elsewhere" | "unrecorded" | "corrupt" | "unsupported";

/** <runDir>/run.json (version 1). */
export interface RunRecord {
  version: 1;
  runDir: string;
  planFile: string;
  source: string;
  domain: string;
  wolf?: string;
  state: RunState;
  pid: number;
  /** Process identity beyond the pid (a reused pid on another host / after a reboot is not this run). */
  host?: string;
  boot?: string;
  startedAt: number;
  /** Heartbeat: last time the owning process touched the record. */
  updatedAt?: number;
  finishedAt?: number;
  concurrency: number;
  resumed: boolean;
  error?: string;
  failures?: string[];
  progress: ProgressSnapshot;
  /** The first release that sent something (kept on re-release). */
  release?: ReleaseRecord;
  /** Every release attempt, oldest first (capped). */
  releases?: ReleaseRecord[];
}
export interface ProgressSnapshot {
  total: number;
  rows: RunRow[];
  journey: RunProgress["journey"];
  gateFailures?: string[];
  usage?: RunProgress["usage"];
  startedAt: number;
}
export interface ReleaseRecord {
  at: number;
  emitted: number;
  skipped: number;
  /** Credentials stripped. */
  dest: string;
  via: "hub" | "inbox";
}

export interface RunView {
  runDir: string;
  state: RunViewState;
  resumable: boolean;
  /** Live progress when this process runs it, else the snapshot from run.json (absent for unrecorded dirs). */
  progress?: RunProgress;
  record?: RunRecord;
  /** True when this process holds the run (an abort controller exists). */
  live: boolean;
}

export type ReleaseTarget = { kind: "hub"; hub: HubTarget } | { kind: "inbox"; opsRoot: string } | { kind: "none" };

export type CrawlServiceErrorCode =
  | "no-target"
  | "not-a-run"
  | "journey-missing"
  | "clash"
  | "bad-plan"
  | "bad-resume"
  | "bad-concurrency"
  | "no-run"
  | "start-failed"
  | "run-active"
  | "run-not-done"
  | "corrupt"
  | "unsupported"
  | "releasing"
  | "not-confirmed"
  | "domains-unknown";

export class CrawlServiceError extends Error {
  constructor(readonly code: CrawlServiceErrorCode, message: string) {
    super(message);
  }
}

export interface CrawlServiceOptions {
  crawlHome: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  runner: CrawlRunner;
  /** The host's plan drafting (crawl-core's draft). */
  planner?: (o: unknown) => unknown;
  /** Declared domains from a local KB mirror (sync); null when there is none. The hub registry is the fallback. */
  localDomains?: () => Set<string> | null;
  /** Injectable for tests. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  identity?: { host: string; boot: string };
  /** Heartbeat period (0 = no timer; call heartbeat() yourself). Default 12 s. */
  heartbeatMs?: number;
  /** A record / reservation without a heartbeat for this long is stale. Default 45 s. */
  staleMs?: number;
  /** How long the hub domain list is trusted. Default 60 s. */
  domainsTtlMs?: number;
  /** After a failed registry read, do not retry for this long (a down hub must not add its timeout to every tool). Default 10 s. */
  domainsRetryMs?: number;
  /** The last good registry is kept while the hub is down, but no longer than this. Default 24 h. */
  domainsMaxAgeMs?: number;
  /** How often release.lock is refreshed during a slow emit. Default 60 s (capped at a third of the lock max age). */
  releaseRefreshMs?: number;
  /** Release lock max age (default 30 min); tests shorten it. */
  releaseLockMaxAgeMs?: number;
  /** Test hook for the lock race tests. */
  lockHook?: (file: string) => void;
}

export interface StartRunInput {
  planPath: string;
  concurrency?: number;
  /** An outstanding run dir to resume (from outstanding()). */
  resume?: IncompleteRun;
  wolf?: string;
  /** Called once a run is accepted. */
  onAccepted?: () => void;
}
export interface StartedRun {
  runDir: string;
  concurrency: number;
  resumed: boolean;
  batches: number;
}

export interface StatusResult {
  runs: RunView[];
  disk: CrawlEntity[];
}

export interface ReleasePreview {
  preview: EmitCrawlResult;
  items: EmitCrawlResult["contributions"];
  toEmit: number;
  unchanged: number;
  release: CrawlReleaseState;
  /** denTopicIds known to be curated, from local receipts and (when the hub answers) the hub. */
  curated: Set<string>;
  /** Unchanged on the hub according to the check seam (undefined: not available). */
  hubUnchanged?: Set<string>;
  /** "unknown": a hub is the target but neither its receipts nor check answered, so "already curated / unchanged" cannot be told. */
  hubState: "ok" | "unknown";
  target: ReleaseTarget;
  journeyMissing: boolean;
  plan: ReturnType<typeof readPlan>;
}

export interface ReleaseRoots {
  denLocal?: string;
  kbBase?: string;
}

export interface ReleaseOptions {
  wolf: string;
  roots?: ReleaseRoots;
  /** Must be true: the user's confirmation lives in the host (a card); the service refuses without it. */
  confirmed?: boolean;
}

/** A file in the run dir asking the owning process to stop (written by stopRun force on a running-elsewhere record, read in heartbeat()). */
export const CANCEL_MARKER = "cancel.request";
const KEEP_FINISHED = 5;
const SAVE_THROTTLE_MS = 1000;
const RELEASE_LOCK_MAX_AGE_MS = 30 * 60_000;
const MAX_RELEASES = 20;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

let cachedBoot: string | undefined;
/** An id that changes on reboot: /proc boot_id on Linux, kern.boottime on macOS, else "unknown". */
export function bootId(): string {
  if (cachedBoot) return cachedBoot;
  let b = "";
  try {
    b = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
  } catch {
    /* not linux */
  }
  if (!b && process.platform === "darwin") {
    try {
      b = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf-8", timeout: 2000 }).trim();
    } catch {
      /* unknown */
    }
  }
  return (cachedBoot = b || "unknown");
}

/** The release target for `env`: the hub when WOLFPACK_HUB_URL is set, else the KB_OPS inbox, else none. */
export function releaseTarget(env: Record<string, string | undefined> = process.env): ReleaseTarget {
  const hub = hubTargetFromEnv(env);
  if (hub) return { kind: "hub", hub };
  if (env.KB_OPS) return { kind: "inbox", opsRoot: env.KB_OPS };
  return { kind: "none" };
}

/** Where a release goes, for people: hub URLs are redacted. */
export const describeTarget = (t: ReleaseTarget, wolf: string): string =>
  t.kind === "hub" ? `hub ${redactUrl(t.hub.baseUrl)} as wolf "${wolf}"` : t.kind === "inbox" ? `inbox lane "${wolf}"` : "no target";

export function parseConcurrency(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, CRAWL_CONCURRENCY_MAX) : undefined;
}

/** WOLFPACK_CRAWL_CONCURRENCY, clamped; the default otherwise. */
export function envConcurrency(env: Record<string, string | undefined>): number {
  const raw = Number(env.WOLFPACK_CRAWL_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), CRAWL_CONCURRENCY_MAX) : DEFAULT_CRAWL_CONCURRENCY;
}

const fromSnapshot = (s: ProgressSnapshot): RunProgress => ({ total: s.total, rows: new Map(s.rows.map((r) => [r.topic, r])), journey: s.journey, gateFailures: s.gateFailures, usage: s.usage, startedAt: s.startedAt });

const STATES = new Set<string>(["running", "done", "failed", "gate-failed", "cancelled"]);
type ReadRun = { kind: "none" } | { kind: "unsupported"; version: unknown } | { kind: "corrupt"; reason: string } | { kind: "ok"; rec: RunRecord };

function readRun(runDir: string): ReadRun {
  const file = join(runDir, "run.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return { kind: "none" };
  }
  try {
    const r = JSON.parse(raw) as Partial<RunRecord>;
    if (r && typeof r === "object" && typeof r.version === "number" && r.version > 1) return { kind: "unsupported", version: r.version }; // written by a newer service: leave it alone
    if (!r || r.version !== 1) return { kind: "corrupt", reason: "unknown version" };
    if (typeof r.state !== "string" || !STATES.has(r.state)) return { kind: "corrupt", reason: "bad state" };
    if (typeof r.pid !== "number") return { kind: "corrupt", reason: "no pid" };
    if (!r.progress || typeof r.progress !== "object" || !Array.isArray((r.progress as ProgressSnapshot).rows)) return { kind: "corrupt", reason: "no progress snapshot" };
    return { kind: "ok", rec: r as RunRecord };
  } catch (e) {
    return { kind: "corrupt", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The run record, or undefined when missing or invalid. */
export function readRunRecord(runDir: string): RunRecord | undefined {
  const r = readRun(runDir);
  return r.kind === "ok" ? r.rec : undefined;
}

let tmpSeq = 0;
/** Atomic write (unique tmp, fsync, rename). Returns an error text instead of throwing. */
function writeFileAtomic(file: string, text: string): string | undefined {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    return undefined;
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* gone */
    }
    return e instanceof Error ? e.message : String(e);
  }
}

function writeRunRecord(rec: RunRecord): string | undefined {
  try {
    mkdirSync(rec.runDir, { recursive: true });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return writeFileAtomic(join(rec.runDir, "run.json"), JSON.stringify(rec, null, 2));
}

const norm = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

interface Held {
  rec: RunRecord;
  progress: RunProgress;
  controller: AbortController;
  lastSave: number;
}

export interface CrawlService {
  readonly crawlHome: string;
  /** Host's plan drafting hook (makes the crawl home first). */
  buildPlan<T = unknown>(o: unknown): T;
  refreshDomains(): Promise<Set<string> | null>;
  declaredDomains(): Set<string> | null;
  /** Throws `domains-unknown` when there is no KB mirror and a hub is configured but its registry could not be read (fail closed). */
  requireDomains(): void;
  /** Unfinished runs of this plan that this service is not running. */
  outstanding(plan: { source: string; domain: string }): IncompleteRun[];
  /** Check domains, reserve the plan on disk, then start a run detached; throws CrawlServiceError. */
  startRun(input: StartRunInput): Promise<StartedRun>;
  /**
   * Abort a run held by this process. A stale foreign record (interrupted) is marked cancelled (takeover). A live foreign run
   * (running-elsewhere) is only stopped with `force`: a cancel marker is written which its owner honours at its next heartbeat
   * (`requested: true`); the record is never rewritten under a live owner.
   */
  stopRun(runDir?: string, opts?: { force?: boolean }): { stopped: string; takenOver?: boolean; requested?: boolean } | { error: "none" | "ambiguous" | "foreign"; running: string[]; pid?: number };
  status(opts?: { runDir?: string; wolf?: string }): StatusResult;
  listRuns(): RunView[];
  releaseTarget(): ReleaseTarget;
  /** Whether a run dir may be previewed / released now (same rule the release itself enforces). */
  releasable(runDir: string): { ok: true } | { ok: false; code: CrawlServiceErrorCode; message: string };
  previewRelease(runDir: string, o: { wolf: string; roots?: ReleaseRoots }): Promise<ReleasePreview>;
  release(runDir: string, o: ReleaseOptions): Promise<EmitCrawlResult & { via: "hub" | "inbox"; warnings: string[] }>;
  /** Resolve a user-given dir to a run under the crawl home (symlinks resolved for the check), or throw. */
  resolveRunDir(dir: string): string;
  /** Touch the heartbeat of every run held here (the timer calls this). */
  heartbeat(): void;
  /** Abort what is in flight and forget the registry (the records stay: those runs read "interrupted"). */
  shutdown(): void;
  /** Wait for every detached run to settle (tests). */
  idle(): Promise<void>;
}

export function createCrawlService(o: CrawlServiceOptions): CrawlService {
  const { crawlHome, env, runner } = o;
  const pid = o.pid ?? process.pid;
  const isAlive = o.isAlive ?? alive;
  const now = o.now ?? Date.now;
  const id = o.identity ?? { host: hostname(), boot: bootId() };
  const heartbeatMs = o.heartbeatMs ?? 12_000;
  const staleMs = o.staleMs ?? 45_000;
  const releaseLockMaxAge = o.releaseLockMaxAgeMs ?? RELEASE_LOCK_MAX_AGE_MS;
  const releaseRefreshMs = o.releaseRefreshMs ?? 60_000;
  const domainsTtlMs = o.domainsTtlMs ?? 60_000;
  const domainsRetryMs = o.domainsRetryMs ?? 10_000;
  const domainsMaxAgeMs = o.domainsMaxAgeMs ?? 24 * 3_600_000;
  const bases = [crawlHome];
  /** The abort-controller cache for runs held by THIS process (state of record is run.json). */
  const held = new Map<string, Held>();
  const settling = new Set<Promise<unknown>>();
  /** Release in progress in this process, by real path. */
  const releasing = new Set<string>();
  let slots = 0;
  let hubDomains: Set<string> | null = null;
  let hubFetchedAt = 0;
  let hubFailedAt: number | undefined;
  /** The last good registry, accepted while the hub is down for at most domainsMaxAgeMs (then it reads as unknown again). */
  const goodHubDomains = (): Set<string> | null => (hubDomains && now() - hubFetchedAt <= domainsMaxAgeMs ? hubDomains : null);
  let timer: ReturnType<typeof setInterval> | undefined;

  const secrets = () => [env.WOLFPACK_HUB_TOKEN, env.ANTHROPIC_API_KEY];
  const clean = (t: string) => scrubSecrets(t, secrets());
  const snapshot = (p: RunProgress): ProgressSnapshot => ({
    total: p.total,
    rows: [...p.rows.values()].map((r) => (r.error ? { ...r, error: clean(r.error) } : r)),
    journey: p.journey,
    ...(p.gateFailures ? { gateFailures: p.gateFailures.map(clean) } : {}),
    ...(p.usage ? { usage: p.usage } : {}),
    startedAt: p.startedAt,
  });

  const save = (h: Held, force = false): string | undefined => {
    const t = now();
    if (!force && t - h.lastSave < SAVE_THROTTLE_MS) return undefined;
    h.lastSave = t;
    h.rec.updatedAt = t;
    h.rec.progress = snapshot(h.progress);
    if (h.rec.runDir.startsWith("pending-")) return undefined;
    return writeRunRecord(h.rec);
  };

  const prune = () => {
    const done = [...held.entries()].filter(([, h]) => h.rec.state !== "running").sort((a, b) => (a[1].rec.finishedAt ?? 0) - (b[1].rec.finishedAt ?? 0));
    for (const [k] of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) held.delete(k);
  };

  const heldFor = (dir: string): Held | undefined => {
    const n = norm(dir);
    for (const h of held.values()) if (norm(h.rec.runDir) === n) return h;
    return undefined;
  };

  const isResumable = (dir: string): boolean => !!readIncompleteRun(dir);

  const viewOfHeld = (h: Held): RunView => ({
    runDir: h.rec.runDir,
    state: h.rec.state,
    resumable: (h.rec.state === "cancelled" || h.rec.state === "failed") && isResumable(h.rec.runDir),
    progress: fromSnapshot(snapshot(h.progress)), // scrubbed like the persisted copy
    record: h.rec,
    live: h.rec.state === "running",
  });

  /**
   * A `running` record this process does not hold: still running elsewhere, or dead.
   * Same host: a (known) different boot id, our own pid, a dead pid or a stale heartbeat = interrupted. Another host: the pid
   * cannot be checked, so only the heartbeat decides.
   */
  const foreignState = (rec: RunRecord): "running-elsewhere" | "interrupted" => {
    const fresh = now() - (rec.updatedAt ?? 0) <= staleMs;
    if (rec.host !== undefined && rec.host !== id.host) return fresh ? "running-elsewhere" : "interrupted";
    if (bootsDiffer(rec.boot, id.boot)) return "interrupted";
    if (rec.pid === pid) return "interrupted"; // our own pid, but not held: a previous service instance
    return fresh && isAlive(rec.pid) ? "running-elsewhere" : "interrupted";
  };

  function viewOfDisk(dir: string): RunView {
    try {
      const r = readRun(dir);
      if (r.kind === "none") return { runDir: dir, state: "unrecorded", resumable: isResumable(dir), live: false };
      if (r.kind === "unsupported") return { runDir: dir, state: "unsupported", resumable: false, live: false };
      if (r.kind === "corrupt") {
        try {
          if (!existsSync(join(dir, "run.json.corrupt"))) copyFileSync(join(dir, "run.json"), join(dir, "run.json.corrupt"));
        } catch {
          /* best effort */
        }
        return { runDir: dir, state: "corrupt", resumable: false, live: false };
      }
      const rec = r.rec;
      const state: RunViewState = rec.state === "running" ? foreignState(rec) : rec.state;
      const resumable = (state === "interrupted" || state === "cancelled" || state === "failed") && isResumable(dir);
      return { runDir: dir, state, resumable, progress: fromSnapshot(rec.progress), record: rec, live: false };
    } catch {
      return { runDir: dir, state: "corrupt", resumable: false, live: false };
    }
  }

  function listRuns(): RunView[] {
    const out = new Map<string, RunView>();
    for (const h of held.values()) out.set(norm(h.rec.runDir), viewOfHeld(h));
    for (const dir of scanCrawlDirs(bases)) if (!out.has(norm(dir)) && (hasFile(dir, "run.json") || hasFile(dir, "observations.jsonl"))) out.set(norm(dir), viewOfDisk(dir));
    return [...out.values()];
  }

  const runningFor = (source: string, domain: string): string | undefined => {
    for (const h of held.values()) if (h.rec.state === "running" && h.rec.source === source && h.rec.domain === domain) return h.rec.runDir;
    for (const v of listRuns()) if (!v.live && v.state === "running-elsewhere" && v.record?.source === source && v.record.domain === domain) return v.runDir;
    return undefined;
  };

  // ── file locks (reservation, release.lock): see lock.ts ──────────────────

  const lockEnv: LockEnv = { pid, host: id.host, boot: id.boot, isAlive, now, ...(o.lockHook ? { afterJudge: o.lockHook } : {}) };
  /** Start reservations this process holds (refreshed by the heartbeat while runner.run is slow to make its sink). */
  const reservations = new Set<HeldLock>();

  // ── heartbeat ────────────────────────────────────────────────────────────

  const anyRunning = () => [...held.values()].some((h) => h.rec.state === "running");
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const ensureTimer = () => {
    if (timer || heartbeatMs <= 0) return;
    timer = setInterval(() => svc.heartbeat(), heartbeatMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const releaseGuard = (dir: string): { ok: true } | { ok: false; code: CrawlServiceErrorCode; message: string } => {
    const h = heldFor(dir);
    const view = h ? viewOfHeld(h) : viewOfDisk(dir);
    switch (view.state) {
      case "running":
      case "running-elsewhere":
        return { ok: false, code: "run-active", message: `${dir} is still running${view.record ? ` (pid ${view.record.pid})` : ""}; wait for it to finish before releasing.` };
      case "interrupted":
        return { ok: false, code: "run-active", message: `${dir} was interrupted and is unfinished; resume it with crawl_run before releasing.` };
      case "failed":
      case "cancelled":
      case "gate-failed":
        return { ok: false, code: "run-not-done", message: `${dir} ${view.state === "gate-failed" ? "was refused by the gate" : view.state}; it is not a finished crawl and cannot be released.` };
      case "unsupported":
        return { ok: false, code: "unsupported", message: `${dir} was written by a newer crawl service (unsupported run.json version); use that version to release it.` };
      case "corrupt":
        return { ok: false, code: "corrupt", message: `${dir} has an unreadable run.json (kept as run.json.corrupt); inspect it before releasing.` };
      default:
        return { ok: true }; // done, or an unrecorded dir from before run records existed
    }
  };

  const reserveName = (source: string, domain: string) => `.reserve-${createHash("sha1").update(source).digest("hex").slice(0, 12)}-${domain.replace(/[^\w.-]/g, "_")}`;

  const svc: CrawlService = {
    crawlHome,

    buildPlan<T>(opts: unknown): T {
      if (!o.planner) throw new Error("no planner configured for this crawl service");
      mkdirSync(crawlHome, { recursive: true });
      return o.planner(opts) as T;
    },

    async refreshDomains() {
      const local = o.localDomains?.() ?? null;
      if (local) return local;
      // No KB mirror here: the hub registry is the source of truth.
      const hub = hubTargetFromEnv(env);
      if (!hub) return null;
      if (hubDomains && now() - hubFetchedAt < domainsTtlMs) return hubDomains;
      if (hubFailedAt !== undefined && now() - hubFailedAt < domainsRetryMs) return goodHubDomains(); // negative cache: do not re-pay the timeout
      const fresh = await listDomainsOnHub(hub);
      if (fresh) {
        hubDomains = fresh;
        hubFetchedAt = now();
        hubFailedAt = undefined;
      } else hubFailedAt = now(); // keep the last good list (never overwrite with null)
      return goodHubDomains();
    },
    declaredDomains() {
      return o.localDomains?.() ?? goodHubDomains();
    },
    requireDomains() {
      if ((o.localDomains?.() ?? null) || goodHubDomains()) return;
      const target = releaseTarget(env);
      if (target.kind === "none") return; // nothing is ever released from here: no domain source to check against
      if (target.kind === "hub") throw new CrawlServiceError("domains-unknown", `The hub's domain registry (${redactUrl(target.hub.baseUrl)}) could not be read and there is no local KB mirror, so the plan's domain cannot be checked. Try again when the hub is reachable.`);
      throw new CrawlServiceError("domains-unknown", "The KB's declared domains could not be read here (no readable KB_BASE + KB_OPS) and no hub is configured, so the plan's domain cannot be checked.");
    },

    outstanding(plan) {
      return findIncompleteRuns(plan, bases).filter((r) => {
        const h = heldFor(r.runDir);
        if (h?.rec.state === "running") return false;
        if (h) return true;
        const st = viewOfDisk(r.runDir).state;
        return st !== "running-elsewhere" && st !== "corrupt" && st !== "unsupported";
      });
    },

    async startRun(input) {
      let plan: ReturnType<typeof readPlan>;
      try {
        plan = readPlan(input.planPath);
      } catch (e) {
        throw new CrawlServiceError("bad-plan", `Cannot read the plan ${input.planPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (input.concurrency !== undefined && parseConcurrency(input.concurrency) === undefined) throw new CrawlServiceError("bad-concurrency", `concurrency must be a number between 1 and ${CRAWL_CONCURRENCY_MAX}.`);
      const concurrency = parseConcurrency(input.concurrency) ?? envConcurrency(env);
      // The only await: domains. After it, check + reservation are synchronous, so overlapping calls cannot both start a plan.
      await svc.refreshDomains();
      svc.requireDomains();

      const clash = runningFor(plan.source, plan.domain);
      if (clash) throw new CrawlServiceError("clash", `A run of this plan is already in progress: ${clash}.`);
      const resume = input.resume;
      if (resume) {
        const st = heldFor(resume.runDir) ? viewOfHeld(heldFor(resume.runDir)!).state : viewOfDisk(resume.runDir).state;
        if (st === "unsupported") throw new CrawlServiceError("unsupported", `${resume.runDir} has a run.json written by a newer crawl service; it cannot be resumed by this version.`);
        if (st === "corrupt") throw new CrawlServiceError("corrupt", `${resume.runDir} has an unreadable run.json; it cannot be resumed.`);
        if (releasing.has(norm(resume.runDir)) || lockHeld(join(resume.runDir, "release.lock"), releaseLockMaxAge, lockEnv)) throw new CrawlServiceError("releasing", `${resume.runDir} is being released; it cannot be resumed now.`);
      }
      mkdirSync(crawlHome, { recursive: true });
      const reservation = join(crawlHome, reserveName(plan.source, plan.domain));
      const reservationLock = acquireLock(reservation, staleMs, lockEnv);
      if (!reservationLock) throw new CrawlServiceError("clash", "Another process is starting a run of this plan right now.");
      reservations.add(reservationLock);
      let reserved = true;
      const unreserve = () => {
        if (reserved) {
          reserved = false;
          reservations.delete(reservationLock);
          releaseLock(reservationLock);
        }
      };
      if (resume) rmSync(join(resume.runDir, CANCEL_MARKER), { force: true });

      const progress = newRunProgress();
      const controller = new AbortController();
      const t = now();
      const key = resume?.runDir ?? `pending-${++slots}`;
      const prior = resume ? readRunRecord(resume.runDir) : undefined;
      const rec: RunRecord = {
        version: 1,
        runDir: key,
        planFile: input.planPath,
        source: plan.source,
        domain: plan.domain,
        ...(input.wolf ? { wolf: input.wolf } : {}),
        state: "running",
        pid,
        host: id.host,
        boot: id.boot,
        startedAt: t,
        updatedAt: t,
        concurrency,
        resumed: !!resume,
        progress: snapshot(progress),
        ...(prior?.release ? { release: prior.release } : {}),
        ...(prior?.releases ? { releases: prior.releases } : {}),
      };
      const h: Held = { rec, progress, controller, lastSave: 0 };
      held.set(key, h);
      if (resume) {
        save(h, true); // run.json says "running" before anything else can look
        unreserve();
      }
      ensureTimer();
      try {
        input.onAccepted?.();
      } catch {
        /* a host callback must not break the start */
      }
      let pending: Promise<RunCrawlResult>;
      try {
        pending = Promise.resolve(
          runner.run(resume ? join(resume.runDir, "plan.yaml") : input.planPath, {
            declared: svc.declaredDomains(),
            concurrency,
            sinkBase: crawlHome,
            signal: controller.signal,
            ...(resume ? { only: resume.missing, runDir: resume.runDir } : {}),
            // Always explicit: a host without a KB must not fall back to the daemon's own KB_BASE.
            kbBase: env.KB_BASE ?? "",
            onSink: (d) => {
              held.delete(key);
              rec.runDir = d;
              held.set(d, h);
              save(h, true);
              unreserve(); // run.json exists now: the dir itself is the claim
            },
            onProgress: (p) => {
              applyProgress(progress, p);
              save(h);
            },
          }),
        );
      } catch (e) {
        // A synchronous throw: never leave a record saying `running`.
        unreserve();
        rec.finishedAt = now();
        rec.state = "failed";
        rec.error = clean(e instanceof Error ? e.message : String(e));
        if (resume || !rec.runDir.startsWith("pending-")) save(h, true);
        else held.delete(key);
        if (!anyRunning()) stopTimer();
        throw new CrawlServiceError("start-failed", `crawl run failed to start: ${rec.error}`);
      }
      const settle = pending.then(
        (res) => {
          rec.finishedAt = now();
          if (res.dir) rec.runDir = res.dir;
          if (res.cancelled) rec.state = "cancelled";
          else if (res.ok) rec.state = "done";
          else {
            rec.state = "gate-failed";
            rec.failures = (res.failures ?? []).map(clean);
          }
        },
        (e) => {
          rec.finishedAt = now();
          rec.state = "failed";
          rec.error = clean(e instanceof Error ? e.message : String(e));
        },
      ).then(() => {
        save(h, true);
        unreserve();
        if (!rec.runDir.startsWith("pending-")) rmSync(join(rec.runDir, CANCEL_MARKER), { force: true });
        prune();
        if (!anyRunning()) stopTimer();
      });
      settling.add(settle);
      void settle.finally(() => settling.delete(settle));
      return { runDir: rec.runDir, concurrency, resumed: !!resume, batches: resume ? resume.missing.length : plan.batches.length };
    },

    stopRun(runDir, opts = {}) {
      const running = [...held.values()].filter((h) => h.rec.state === "running" && (!runDir || norm(h.rec.runDir) === norm(runDir)));
      if (running.length === 1) {
        running[0].controller.abort();
        return { stopped: running[0].rec.runDir };
      }
      if (running.length > 1) return { error: "ambiguous", running: running.map((h) => h.rec.runDir) };
      if (runDir) {
        const v = viewOfDisk(runDir);
        if (v.record && v.state === "interrupted") {
          // Takeover of a stale record: its owner is gone (or its heartbeat stopped), so it cannot be overwritten under anyone.
          const rec: RunRecord = { ...v.record, state: "cancelled", finishedAt: now(), updatedAt: now(), error: "taken over: the owning process is gone" };
          if (!writeRunRecord(rec)) return { stopped: runDir, takenOver: true };
        } else if (v.state === "running-elsewhere") {
          if (!opts.force) return { error: "foreign", running: [runDir], pid: v.record?.pid };
          try {
            writeFileSync(join(runDir, CANCEL_MARKER), JSON.stringify({ at: now(), by: pid }));
            return { stopped: runDir, requested: true };
          } catch {
            return { error: "foreign", running: [runDir], pid: v.record?.pid };
          }
        }
      }
      return { error: "none", running: [] };
    },

    listRuns,

    status(opts = {}) {
      const runs = listRuns().filter((r) => !opts.runDir || norm(r.runDir) === norm(opts.runDir));
      const lane = { opsRoot: env.KB_OPS || undefined, wolf: opts.wolf };
      const disk = listCrawls(bases, lane).filter((e) => !opts.runDir || norm(e.dir) === norm(opts.runDir));
      return { runs, disk };
    },

    releaseTarget: () => releaseTarget(env),

    resolveRunDir(dir) {
      const d = resolve(dir);
      const root = norm(crawlHome);
      const real = norm(d);
      if (!real.startsWith(root + sep) || !hasFile(d, "plan.yaml")) throw new CrawlServiceError("not-a-run", `${dir} is not a crawl run under ${crawlHome}.`);
      return d;
    },

    releasable(runDir) {
      try {
        return releaseGuard(svc.resolveRunDir(runDir));
      } catch (e) {
        return { ok: false, code: e instanceof CrawlServiceError ? e.code : "not-a-run", message: e instanceof Error ? e.message : String(e) };
      }
    },

    async previewRelease(runDir, ro) {
      const dir = svc.resolveRunDir(runDir);
      const guard = releaseGuard(dir);
      if (!guard.ok) throw new CrawlServiceError(guard.code, guard.message);
      const plan = readPlan(join(dir, "plan.yaml"));
      const opsRoot = env.KB_OPS || undefined;
      const roots = { ...(opsRoot ? { opsRoot } : {}), ...(env.KB_BASE ? { kbBase: env.KB_BASE } : {}), ...(ro.roots?.denLocal ? { denLocal: ro.roots.denLocal } : {}) };
      // Built locally (never touches the hub or the inbox): a dry run renders into the sink.
      const preview = await runner.emit(dir, { dryRun: true, wolf: ro.wolf, sinkBase: crawlHome, quiet: true, roots });
      const items = preview.contributions;
      const toEmit = items.filter((c) => c.status === "emit").length;
      const release = readReleaseState(dir, opsRoot, ro.wolf, denTopicIdsForPlan(plan));
      const curated = new Set(release.curated);
      const target = releaseTarget(env);
      let hubUnchanged: Set<string> | undefined;
      let hubState: "ok" | "unknown" = "ok";
      if (target.kind === "hub") {
        // Seams for the hub receipts / check endpoints (work-wolfpack-ZBZPAZ9); undefined until they exist or while the hub is unreachable.
        const receipts = await readHubReceipts(target.hub);
        for (const id of receipts ?? []) curated.add(id);
        hubUnchanged = await checkHubContributions(target.hub, items.map((c) => ({ denTopicId: c.denTopicId })));
        if (receipts === undefined && hubUnchanged === undefined) hubState = "unknown";
      }
      return { preview, items, toEmit, unchanged: items.length - toEmit, release, curated, hubUnchanged, hubState, target, journeyMissing: !hasFile(dir, "history.json"), plan };
    },

    async release(runDir, ro) {
      if (ro.confirmed !== true) throw new CrawlServiceError("not-confirmed", "A release needs the user's confirmation (confirmed: true).");
      const dir = svc.resolveRunDir(runDir);
      const key = norm(dir);
      if (releasing.has(key)) throw new CrawlServiceError("releasing", `${dir} is already being released.`);
      releasing.add(key);
      const lock = join(dir, "release.lock");
      let locked: HeldLock | undefined;
      try {
        locked = acquireLock(lock, releaseLockMaxAge, lockEnv);
        if (!locked) throw new CrawlServiceError("releasing", `${dir} is being released by another process.`);
        // Everything is rechecked now that nothing else can release this dir.
        const target = releaseTarget(env);
        if (target.kind === "none") throw new CrawlServiceError("no-target", "No release target is configured here (neither WOLFPACK_HUB_URL nor KB_OPS), so this cannot be released.");
        const guard = releaseGuard(dir);
        if (!guard.ok) throw new CrawlServiceError(guard.code, guard.message);
        if (!hasFile(dir, "history.json")) throw new CrawlServiceError("journey-missing", "The run's journey is not written yet — finish it (resume the run) before releasing.");
        const opsRoot = env.KB_OPS || undefined;
        const roots = { ...(opsRoot ? { opsRoot } : {}), ...(env.KB_BASE ? { kbBase: env.KB_BASE } : {}), ...(ro.roots?.denLocal ? { denLocal: ro.roots.denLocal } : {}) };
        // A release can outlast the lock max age (a big hub batch): keep the lock fresh for as long as the emit runs.
        const keepAlive = setInterval(() => refreshLock(locked!, lockEnv), Math.max(10, Math.min(releaseRefreshMs, releaseLockMaxAge / 3)));
        keepAlive.unref?.();
        let r: Awaited<ReturnType<CrawlRunner["emit"]>>;
        try {
          r = await runner.emit(dir, { dryRun: false, wolf: ro.wolf, sinkBase: crawlHome, quiet: true, roots });
        } finally {
          clearInterval(keepAlive);
        }
        const via = target.kind === "hub" ? "hub" : "inbox";
        const warnings: string[] = [];
        const entry: ReleaseRecord = { at: now(), emitted: r.emitted, skipped: r.skipped, dest: r.dest, via };

        // emitted.json: keep the first real release at the top level; every attempt goes in `releases`.
        let prev: { at?: number; emitted?: number; dest?: string; via?: "hub" | "inbox"; skipped?: number; releases?: ReleaseRecord[] } | undefined;
        try {
          prev = JSON.parse(readFileSync(join(dir, "emitted.json"), "utf-8"));
        } catch {
          /* first release */
        }
        const prevTop = prev && typeof prev.at === "number" ? ({ at: prev.at, emitted: prev.emitted ?? 0, skipped: prev.skipped ?? 0, dest: prev.dest ?? "", via: prev.via ?? via } as ReleaseRecord) : undefined;
        const keepPrev = !!prevTop && (prevTop.emitted > 0 || entry.emitted === 0);
        const top = keepPrev ? prevTop! : entry;
        const releases = [...(prev?.releases ?? (prevTop ? [prevTop] : [])), entry].slice(-MAX_RELEASES);
        const e1 = writeFileAtomic(join(dir, "emitted.json"), JSON.stringify({ ...top, releases }, null, 2));
        if (e1) warnings.push(`released, but could not write emitted.json (${e1}); the run may look unreleased`);

        // run.json: through the held record when this process has one (never read-modify-write over a live record).
        const h = heldFor(dir);
        if (h) {
          h.rec.release = h.rec.release && (h.rec.release.emitted > 0 || entry.emitted === 0) ? h.rec.release : entry;
          h.rec.releases = [...(h.rec.releases ?? []), entry].slice(-MAX_RELEASES);
          const e2 = save(h, true);
          if (e2) warnings.push(`released, but could not update run.json (${e2})`);
        } else {
          const cur = readRun(dir);
          if (cur.kind === "ok") {
            const rec = cur.rec;
            const first = rec.release && (rec.release.emitted > 0 || entry.emitted === 0) ? rec.release : entry;
            const e2 = writeRunRecord({ ...rec, release: first, releases: [...(rec.releases ?? []), entry].slice(-MAX_RELEASES) });
            if (e2) warnings.push(`released, but could not update run.json (${e2})`);
          }
        }
        return { ...r, via, warnings };
      } finally {
        if (locked) releaseLock(locked);
        releasing.delete(key);
      }
    },

    heartbeat() {
      for (const h of held.values()) if (h.rec.state === "running") save(h, true);
      for (const l of reservations) refreshLock(l, lockEnv);
      // A force-stop request from another process (stopRun on a running-elsewhere record) arrives as a marker file.
      for (const h of held.values()) {
        if (h.rec.state !== "running" || h.rec.runDir.startsWith("pending-")) continue;
        const marker = join(h.rec.runDir, CANCEL_MARKER);
        if (existsSync(marker)) {
          rmSync(marker, { force: true });
          h.controller.abort();
        }
      }
      if (!anyRunning()) stopTimer();
    },

    shutdown() {
      stopTimer();
      for (const h of held.values()) if (h.rec.state === "running") h.controller.abort();
      held.clear();
    },

    async idle() {
      while (settling.size) await Promise.allSettled([...settling]);
    },
  };
  return svc;
}

/** The production runner pieces that need no host: a real release goes hub-first, the dry run is always local. */
export function defaultEmit(env: Record<string, string | undefined>): CrawlRunner["emit"] {
  return (runDir, opts) => {
    const hub = opts.dryRun ? undefined : hubTargetFromEnv(env);
    return hub ? emitCrawlToHub(runDir, hub, opts) : emitCrawl(runDir, opts);
  };
}
