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
 *   refreshDomains / declaredDomains         declared domains from the KB mirror, else from the hub registry.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { emitCrawl, type EmitCrawlOptions, type EmitCrawlResult } from "./emit.js";
import { checkHubContributions, emitCrawlToHub, hubTargetFromEnv, listDomainsOnHub, readHubReceipts, redactUrl, type HubTarget } from "./hub.js";
import { readPlan } from "./plan.js";
import { DEFAULT_CRAWL_CONCURRENCY, runCrawl, type RunCrawlOptions, type RunCrawlResult } from "./run.js";
import {
  applyProgress,
  denTopicIdsForPlan,
  findIncompleteRuns,
  hasFile,
  listCrawls,
  newRunProgress,
  readReleaseState,
  scanCrawlDirs,
  type CrawlEntity,
  type CrawlReleaseState,
  type IncompleteRun,
  type RunProgress,
  type RunRow,
} from "./runs.js";

export const CRAWL_CONCURRENCY_MAX = 32;

/** The engine entry points; hosts / tests replace them (a real run needs an LLM, a real release the KB inbox or hub). */
export interface CrawlRunner {
  run(planFile: string, opts: RunCrawlOptions): Promise<RunCrawlResult>;
  emit(runDir: string, opts: EmitCrawlOptions): EmitCrawlResult | Promise<EmitCrawlResult>;
}

export type RunState = "running" | "done" | "failed" | "gate-failed" | "cancelled";
/** What status reports: a recorded state, or one derived from disk. */
export type RunViewState = RunState | "interrupted" | "running-elsewhere" | "unrecorded";

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
  startedAt: number;
  finishedAt?: number;
  concurrency: number;
  resumed: boolean;
  error?: string;
  failures?: string[];
  progress: ProgressSnapshot;
  release?: ReleaseRecord;
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

export class CrawlServiceError extends Error {
  constructor(readonly code: "no-target" | "not-a-run" | "journey-missing" | "clash" | "bad-plan" | "bad-resume" | "bad-concurrency" | "no-run", message: string) {
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
  target: ReleaseTarget;
  journeyMissing: boolean;
  plan: ReturnType<typeof readPlan>;
}

export interface ReleaseRoots {
  denLocal?: string;
  kbBase?: string;
}

const KEEP_FINISHED = 5;
const SAVE_THROTTLE_MS = 1000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

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

const snapshot = (p: RunProgress): ProgressSnapshot => ({ total: p.total, rows: [...p.rows.values()], journey: p.journey, ...(p.gateFailures ? { gateFailures: p.gateFailures } : {}), ...(p.usage ? { usage: p.usage } : {}), startedAt: p.startedAt });
const fromSnapshot = (s: ProgressSnapshot): RunProgress => ({ total: s.total, rows: new Map(s.rows.map((r) => [r.topic, r])), journey: s.journey, gateFailures: s.gateFailures, usage: s.usage, startedAt: s.startedAt });

export function readRunRecord(runDir: string): RunRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(join(runDir, "run.json"), "utf-8")) as Partial<RunRecord>;
    if (r?.version !== 1 || typeof r.state !== "string" || typeof r.pid !== "number") return undefined;
    return r as RunRecord;
  } catch {
    return undefined;
  }
}

function writeRunRecord(rec: RunRecord): void {
  try {
    mkdirSync(rec.runDir, { recursive: true });
    const tmp = join(rec.runDir, "run.json.tmp");
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, join(rec.runDir, "run.json"));
  } catch {
    /* the record is best effort: the run itself must not die on it */
  }
}

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
  /** Unfinished runs of this plan that this service is not running. */
  outstanding(plan: { source: string; domain: string }): IncompleteRun[];
  /** Reserve + start a run detached; throws CrawlServiceError. */
  startRun(input: StartRunInput): StartedRun;
  /** Abort a run held by this process; returns its dir. */
  stopRun(runDir?: string): { stopped: string } | { error: "none" | "ambiguous"; running: string[] };
  status(opts?: { runDir?: string; wolf?: string }): StatusResult;
  listRuns(): RunView[];
  releaseTarget(): ReleaseTarget;
  previewRelease(runDir: string, o: { wolf: string; roots?: ReleaseRoots }): Promise<ReleasePreview>;
  release(runDir: string, o: { wolf: string; roots?: ReleaseRoots }): Promise<EmitCrawlResult & { via: "hub" | "inbox" }>;
  /** Resolve a user-given dir to a run under the crawl home, or throw. */
  resolveRunDir(dir: string): string;
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
  const bases = [crawlHome];
  /** The abort-controller cache for runs held by THIS process (state of record is run.json). */
  const held = new Map<string, Held>();
  const settling = new Set<Promise<unknown>>();
  let slots = 0;
  let hubDomains: Set<string> | null = null;

  const save = (h: Held, force = false) => {
    const t = now();
    if (!force && t - h.lastSave < SAVE_THROTTLE_MS) return;
    h.lastSave = t;
    h.rec.progress = snapshot(h.progress);
    if (!h.rec.runDir.startsWith("pending-")) writeRunRecord(h.rec);
  };

  const prune = () => {
    const done = [...held.entries()].filter(([, h]) => h.rec.state !== "running").sort((a, b) => (a[1].rec.finishedAt ?? 0) - (b[1].rec.finishedAt ?? 0));
    for (const [k] of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) held.delete(k);
  };

  const viewOfHeld = (h: Held): RunView => ({
    runDir: h.rec.runDir,
    state: h.rec.state,
    resumable: h.rec.state === "cancelled" || h.rec.state === "failed",
    progress: h.progress,
    record: h.rec,
    live: h.rec.state === "running",
  });

  function viewOfDisk(dir: string): RunView {
    const rec = readRunRecord(dir);
    if (!rec) return { runDir: dir, state: "unrecorded", resumable: hasFile(dir, "observations.jsonl") && !hasFile(dir, "history.json"), live: false };
    let state: RunViewState = rec.state;
    if (rec.state === "running") state = rec.pid !== pid && isAlive(rec.pid) ? "running-elsewhere" : "interrupted";
    return { runDir: dir, state, resumable: state === "interrupted" || state === "cancelled" || state === "failed", progress: fromSnapshot(rec.progress), record: rec, live: false };
  }

  function listRuns(): RunView[] {
    const out = new Map<string, RunView>();
    for (const h of held.values()) out.set(h.rec.runDir, viewOfHeld(h));
    for (const dir of scanCrawlDirs(bases)) if (!out.has(dir) && (hasFile(dir, "run.json") || hasFile(dir, "observations.jsonl"))) out.set(dir, viewOfDisk(dir));
    return [...out.values()];
  }

  const runningFor = (source: string, domain: string): string | undefined => {
    for (const h of held.values()) if (h.rec.state === "running" && h.rec.source === source && h.rec.domain === domain) return h.rec.runDir;
    for (const v of listRuns()) if (!v.live && v.state === "running-elsewhere" && v.record?.source === source && v.record.domain === domain) return v.runDir;
    return undefined;
  };

  const envConcurrency = (): number => {
    const raw = Number(env.WOLFPACK_CRAWL_CONCURRENCY);
    return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), CRAWL_CONCURRENCY_MAX) : DEFAULT_CRAWL_CONCURRENCY;
  };

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
      hubDomains = hub ? await listDomainsOnHub(hub) : null;
      return hubDomains;
    },
    declaredDomains() {
      return o.localDomains?.() ?? hubDomains;
    },

    outstanding(plan) {
      const running = new Set([...held.values()].filter((h) => h.rec.state === "running").map((h) => h.rec.runDir));
      return findIncompleteRuns(plan, bases).filter((r) => !running.has(r.runDir) && viewOfDisk(r.runDir).state !== "running-elsewhere");
    },

    startRun(input) {
      let plan: ReturnType<typeof readPlan>;
      try {
        plan = readPlan(input.planPath);
      } catch (e) {
        throw new CrawlServiceError("bad-plan", `Cannot read the plan ${input.planPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (input.concurrency !== undefined && parseConcurrency(input.concurrency) === undefined) throw new CrawlServiceError("bad-concurrency", `concurrency must be a number between 1 and ${CRAWL_CONCURRENCY_MAX}.`);
      const concurrency = parseConcurrency(input.concurrency) ?? envConcurrency();
      // From here to the reservation there is no await: two overlapping calls cannot both start a run of this plan.
      const clash = runningFor(plan.source, plan.domain);
      if (clash) throw new CrawlServiceError("clash", `A run of this plan is already in progress: ${clash}.`);
      const resume = input.resume;
      const progress = newRunProgress();
      const controller = new AbortController();
      const t = now();
      const key = resume?.runDir ?? `pending-${++slots}`;
      const rec: RunRecord = {
        version: 1,
        runDir: key,
        planFile: input.planPath,
        source: plan.source,
        domain: plan.domain,
        ...(input.wolf ? { wolf: input.wolf } : {}),
        state: "running",
        pid,
        startedAt: t,
        concurrency,
        resumed: !!resume,
        progress: snapshot(progress),
        ...(resume ? { release: readRunRecord(resume.runDir)?.release } : {}),
      };
      const h: Held = { rec, progress, controller, lastSave: 0 };
      held.set(key, h);
      if (resume) save(h, true);
      input.onAccepted?.();
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
            },
            onProgress: (p) => {
              applyProgress(progress, p);
              save(h);
            },
          }),
        );
      } catch (e) {
        held.delete(key);
        throw new CrawlServiceError("bad-plan", `crawl run failed to start: ${e instanceof Error ? e.message : String(e)}`);
      }
      const settle = pending.then(
        (res) => {
          rec.finishedAt = now();
          if (res.dir) rec.runDir = res.dir;
          if (res.cancelled) rec.state = "cancelled";
          else if (res.ok) rec.state = "done";
          else {
            rec.state = "gate-failed";
            rec.failures = res.failures ?? [];
          }
          save(h, true);
          prune();
        },
        (e) => {
          rec.finishedAt = now();
          rec.state = "failed";
          rec.error = e instanceof Error ? e.message : String(e);
          save(h, true);
          prune();
        },
      );
      settling.add(settle);
      void settle.finally(() => settling.delete(settle));
      return { runDir: rec.runDir, concurrency, resumed: !!resume, batches: resume ? resume.missing.length : plan.batches.length };
    },

    stopRun(runDir) {
      const running = [...held.values()].filter((h) => h.rec.state === "running" && (!runDir || h.rec.runDir === runDir));
      if (running.length === 0) return { error: "none", running: [] };
      if (running.length > 1) return { error: "ambiguous", running: running.map((h) => h.rec.runDir) };
      running[0].controller.abort();
      return { stopped: running[0].rec.runDir };
    },

    listRuns,

    status(opts = {}) {
      const runs = listRuns().filter((r) => !opts.runDir || r.runDir === opts.runDir);
      const lane = { opsRoot: env.KB_OPS || undefined, wolf: opts.wolf };
      const disk = listCrawls(bases, lane).filter((e) => !opts.runDir || e.dir === opts.runDir);
      return { runs, disk };
    },

    releaseTarget: () => releaseTarget(env),

    resolveRunDir(dir) {
      const d = resolve(dir);
      if (!d.startsWith(resolve(crawlHome) + sep) || !hasFile(d, "plan.yaml")) throw new CrawlServiceError("not-a-run", `${dir} is not a crawl run under ${crawlHome}.`);
      return d;
    },

    async previewRelease(runDir, ro) {
      const dir = svc.resolveRunDir(runDir);
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
      if (target.kind === "hub") {
        // Seams for the hub receipts / check endpoints (work-wolfpack-ZBZPAZ9); undefined until they exist.
        for (const id of (await readHubReceipts(target.hub)) ?? []) curated.add(id);
        hubUnchanged = await checkHubContributions(target.hub, items.map((c) => ({ denTopicId: c.denTopicId })));
      }
      return { preview, items, toEmit, unchanged: items.length - toEmit, release, curated, hubUnchanged, target, journeyMissing: !hasFile(dir, "history.json"), plan };
    },

    async release(runDir, ro) {
      const dir = svc.resolveRunDir(runDir);
      const target = releaseTarget(env);
      if (target.kind === "none") throw new CrawlServiceError("no-target", "No release target is configured here (neither WOLFPACK_HUB_URL nor KB_OPS), so this cannot be released.");
      if (!hasFile(dir, "history.json")) throw new CrawlServiceError("journey-missing", "The run's journey is not written yet — finish it (resume the run) before releasing.");
      const opsRoot = env.KB_OPS || undefined;
      const roots = { ...(opsRoot ? { opsRoot } : {}), ...(env.KB_BASE ? { kbBase: env.KB_BASE } : {}), ...(ro.roots?.denLocal ? { denLocal: ro.roots.denLocal } : {}) };
      const base: EmitCrawlOptions = { dryRun: false, wolf: ro.wolf, sinkBase: crawlHome, quiet: true, roots };
      const r = await runner.emit(dir, base);
      const via = target.kind === "hub" ? "hub" : "inbox";
      const at = now();
      try {
        writeFileSync(join(dir, "emitted.json"), JSON.stringify({ at, emitted: r.emitted, dest: r.dest, via }, null, 2));
      } catch {
        /* non-fatal */
      }
      const rec = readRunRecord(dir);
      if (rec) writeRunRecord({ ...rec, release: { at, emitted: r.emitted, skipped: r.skipped, dest: r.dest, via } });
      return { ...r, via };
    },

    shutdown() {
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

/** The unrecorded-dir helper for callers that only need "did anything run here". */
export const hasRunRecord = (dir: string): boolean => existsSync(join(dir, "run.json")) && statSync(join(dir, "run.json")).isFile();
