/**
 * Work API client — typed HTTP client for the shared work API.
 *
 * Reads WORK_ENDPOINT and WORK_TOKEN from env. All wolves hit the same
 * endpoint on the wolfpack agent (the VPS host:3141/work).
 */

import type { WorkItem, CreateWorkInput, WorkQuery } from "@wolfpack/kb/client";
import type { RollupClient } from "@wolfpack/memory";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Every Work call gives up after this long: binding self-detection must never hang a prompt or a tool. */
export const WORK_TIMEOUT_MS = 3000;

/** Graduation reads a whole domain and runs on the owner's say-so, so it may wait much longer than a binding lookup. */
export const GRADUATION_TIMEOUT_MS = 60_000;

/** Thrown for a write the hub refused because its work store is read-only. The message is what the model sees. */
export class WorkStoreReadOnlyError extends Error {
  readonly code = "work_store_read_only";
  constructor() {
    super("The work store is read-only on this host: you can read work items, but creating or changing them is not possible here, and nothing was changed. Do not retry; tell the owner that work writes are turned off for this wolf.");
    this.name = "WorkStoreReadOnlyError";
  }
}

/** Thrown for a write the hub refused with a permission error (EACCES/EPERM). The message is what the model sees. */
export class WorkStorePermissionError extends Error {
  readonly code = "work_store_permission_denied";
  constructor() {
    super("The hub's work store refused this write with a permission error, so nothing was changed. This looks like a permission fault on the hub, not a deliberate setting. Do not retry; tell the owner to check the hub's permissions on the work store.");
    this.name = "WorkStorePermissionError";
  }
}

/** What the model sees for a write that was saved for later instead of reaching the hub. */
export const QUEUED_TEXT = "Queued, hub unreachable: the change is saved on this host and will be sent, in order, once the hub is back. Do not retry it.";

/** Thrown by a write that was saved in the outbox instead of reaching the hub. Nothing is lost; the caller reports QUEUED_TEXT, not a failure. */
export class WorkQueuedError extends Error {
  readonly code = "work_write_queued";
  constructor() {
    super(QUEUED_TEXT);
    this.name = "WorkQueuedError";
  }
}

interface QueuedWrite { key: string; method: string; path: string; body?: unknown }
type Sent =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; data: Record<string, unknown> }
  | { unreachable: true; error: unknown; status?: number };

/** `<hybrid ms, 15>-<pid, 10>-<seq, 6>-<key>.json`: sorted by name = the order the writes were made in (see stamp). */
const QUEUE_FILE = /^\d{15}-\d{10}-\d{6}-[A-Za-z0-9-]+\.json$/;
/** Outbox dirs being flushed in this process: several clients (withTimeout copies) share one dir and must not send a file twice. */
const flushingDirs = new Set<string>();
let seq = 0;

/** A lock older than this is a holder that hung or crashed with its pid reused: taken over. */
export const OUTBOX_LOCK_STALE_MS = 2 * 60_000;
/** A temp file older than this is a write that crashed before its rename: removed (its write was never queued). */
export const OUTBOX_TMP_STALE_MS = 60_000;
/** A write the hub answered with a 5xx this many times on replay is taken for one that can never succeed: moved to rejected/. */
export const OUTBOX_MAX_ATTEMPTS = 20;
/** Two 5xx answers closer together than this count as one try toward OUTBOX_MAX_ATTEMPTS. */
export const OUTBOX_ATTEMPT_SPACING_MS = 30_000;
/** How long a new write waits for the lock (another process sending one write) before it is saved without it. */
const LOCK_WAIT_MS = 10_000;

const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is that process still running? EPERM: it runs as another user, so yes. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errno(e) === "EPERM";
  }
}

/** A lock file with no readable pid (torn, or not ours) is taken over only once it is older than this. */
const LOCK_UNPARSEABLE_STALE_MS = 5_000;

/** Create `file` holding `content` atomically: written to a unique temp file, then hard-linked into place. False when it exists. */
function linkInto(dir: string, file: string, content: string): boolean {
  const tmp = join(dir, `.lock-${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if (errno(e) !== "EEXIST") throw e;
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * `<dir>/flush.lock`, holding `<pid>\n<token>`. Every process of every wolf on this den takes it to send or to save a write, so
 * one file is never replayed twice and the hybrid clock never hands out a name twice.
 * Taking it is a hard link of a complete temp file, so a lock is never seen half-written. A lock whose pid is dead, or older
 * than OUTBOX_LOCK_STALE_MS, is stale (one with no readable pid only past LOCK_UNPARSEABLE_STALE_MS). A stale lock is taken over
 * by renaming it to a unique tombstone and checking the tombstone still holds the exact content inspected; if another process
 * has replaced it with a fresh lock meanwhile, that lock is linked back (only if flush.lock is still free) and this one backs off.
 * REMAINING WINDOW: between that rename and the link back, a third process can take the free flush.lock, and the link back then
 * fails, so two holders run at once. It needs three processes inside a few microseconds on a stale lock; the hub's
 * Idempotency-Key store is the backstop (a write sent twice applies once). `hooks.beforeTakeover` runs between the inspection
 * and the takeover (tests interleave a second taker there). Returns a release function, or undefined when held.
 */
export function tryOutboxLock(dir: string, hooks: { beforeTakeover?: () => void } = {}): (() => void) | undefined {
  const file = join(dir, "flush.lock");
  const token = `${process.pid}\n${randomUUID()}\n`;
  for (let round = 0; round < 2; round++) {
    if (linkInto(dir, file, token)) {
      return () => {
        try {
          if (readFileSync(file, "utf8") === token) rmSync(file, { force: true });
        } catch { /* already gone or taken over */ }
      };
    }
    if (round) break;
    let seen: string;
    let age: number;
    try {
      seen = readFileSync(file, "utf8");
      age = Date.now() - statSync(file).mtimeMs;
    } catch (e) {
      if (errno(e) !== "ENOENT") throw e;
      continue; // released between our link and our read: try again
    }
    const first = seen.split("\n")[0] ?? "";
    const pid = /^\d+$/.test(first) ? Number(first) : NaN;
    const stale = Number.isNaN(pid) ? age > LOCK_UNPARSEABLE_STALE_MS : !alive(pid) || age > OUTBOX_LOCK_STALE_MS;
    if (!stale) return undefined;
    hooks.beforeTakeover?.();
    const tomb = join(dir, `.tomb-${process.pid}-${randomUUID()}.tmp`);
    try {
      renameSync(file, tomb);
    } catch (e) {
      if (errno(e) !== "ENOENT") throw e;
      continue; // someone else removed it: try to take it
    }
    let got: string | undefined;
    try { got = readFileSync(tomb, "utf8"); } catch { /* unreadable: not the one we inspected */ }
    if (got === seen) {
      rmSync(tomb, { force: true });
      continue;
    }
    // We moved someone's fresh lock: put it back if flush.lock is still free (link fails with EEXIST otherwise), and back off.
    try { linkSync(tomb, file); } catch { /* taken meanwhile: see REMAINING WINDOW */ }
    rmSync(tomb, { force: true });
    return undefined;
  }
  return undefined;
}

/** The wolf-facing words for a handoff or an inherited assignee: "; now assigned to hal" (empty when nothing was reassigned). */
export function handoffText(reassigned: { id: string; from: string | null; to: string }[]): string {
  return reassigned.map((r) => `; now assigned to ${r.to}`).join("");
}

/**
 * The note a create adds when the item did not get the assignee the wolf asked for (a feature's assignee wins). Empty when nothing
 * was asked, the ask was met, or the ask was the wolf's own name and the hub's "now assigned to X" already said it.
 */
export function overrideNote(requested: string | undefined, got: string | undefined, wolf: string, assignedTo?: string): string {
  if (!requested || !got || got === requested) return "";
  if (assignedTo && requested === wolf) return "";
  return `; the feature's assignee ${got} applies, not ${requested}`;
}

export class WorkClient {
  private endpoint: string;
  private token: string;
  private timeoutMs: number;
  private outboxDir: string | undefined;
  /** The wolf this client acts as: sent as X-Wolf so the hub knows which wolf of a multi-wolf host is writing. */
  private wolf: string | undefined;

  /**
   * `outboxDir`: where writes wait while the hub is unreachable (one file per write, sent oldest first with its Idempotency-Key, so a
   * resend never applies twice). Without it a write that cannot reach the hub throws as before.
   */
  constructor(endpoint?: string, token?: string, timeoutMs: number = WORK_TIMEOUT_MS, outboxDir?: string, wolf?: string) {
    this.wolf = wolf ?? process.env.WOLF_NAME;
    this.outboxDir = outboxDir;
    this.timeoutMs = timeoutMs;
    this.endpoint = (endpoint ?? process.env.WORK_ENDPOINT ?? "").replace(/\/$/, "");
    this.token = token ?? process.env.WORK_TOKEN ?? "";
  }

  /** The same hub and token with another per-request limit (the default stays WORK_TIMEOUT_MS). */
  withTimeout(ms: number): WorkClient {
    return new WorkClient(this.endpoint, this.token, ms, this.outboxDir, this.wolf);
  }

  get configured(): boolean {
    return !!(this.endpoint && this.token);
  }

  /**
   * One HTTP attempt. Unreachable = no answer in time, a connection error, 408/429, or a 5xx the hub did not type as a refusal
   * (read-only / permission). Every other non-2xx is an answer: the hub refused the write and will refuse it again.
   */
  private async send(method: string, path: string, body: unknown, key?: string): Promise<Sent> {
    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/work${path}`, {
        method,
        headers: {
          "X-API-Key": this.token,
          ...(this.wolf ? { "X-Wolf": this.wolf } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { unreachable: true, error };
    }
    let data: Record<string, unknown> = {};
    try { data = (await res.json()) as Record<string, unknown>; } catch { /* not JSON (a proxy's error page) */ }
    if (res.ok) return { ok: true, data };
    const typed = data.code === "work_store_read_only" || data.code === "work_store_permission_denied";
    if ((res.status >= 500 && !typed) || res.status === 408 || res.status === 429) return { unreachable: true, status: res.status, error: new Error(String(data.error ?? `HTTP ${res.status}`)) };
    return { ok: false, status: res.status, data };
  }

  private pending(): string[] {
    if (!this.outboxDir) return [];
    try { return readdirSync(this.outboxDir).filter((f) => QUEUE_FILE.test(f)).sort(); } catch { return []; }
  }

  /** Writes waiting in the outbox. */
  get queued(): number {
    return this.pending().length;
  }

  /** Move a queued write (and its attempts count) to rejected/. Tolerates a file another holder already moved. */
  private reject(file: string, why: string): void {
    const dir = this.outboxDir!;
    mkdirSync(join(dir, "rejected"), { recursive: true });
    try {
      renameSync(join(dir, file), join(dir, "rejected", file));
    } catch (e) {
      if (errno(e) !== "ENOENT") throw e;
    }
    rmSync(join(dir, `${file}.attempts`), { force: true });
    console.warn(`[work-outbox] a queued write was given up (${file}): ${why.slice(0, 200)}; moved to rejected/`);
  }

  /** Remove temp files of saves that crashed before their rename (never queued, so nothing is lost that was reported queued). */
  private sweepTmp(dir: string): void {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names.filter((x) => x.startsWith(".") && x.endsWith(".tmp"))) {
      try {
        if (Date.now() - statSync(join(dir, n)).mtimeMs > OUTBOX_TMP_STALE_MS) rmSync(join(dir, n), { force: true });
      } catch { /* gone meanwhile */ }
    }
  }

  /**
   * One more 5xx answer on replay; returns the count so far (kept with the time it was last counted in `<file>.attempts`, so it
   * survives a restart). A failure less than OUTBOX_ATTEMPT_SPACING_MS after the last counted one is not counted: a burst of
   * flushes against a hub that fails for a minute must not use up the 20 tries.
   */
  private countAttempt(file: string): number {
    const side = join(this.outboxDir!, `${file}.attempts`);
    let n = 0;
    let t = -Infinity;
    try {
      const o = JSON.parse(readFileSync(side, "utf8")) as { n?: unknown; t?: unknown };
      if (typeof o.n === "number") n = o.n;
      if (typeof o.t === "number") t = o.t;
    } catch { /* first, or unreadable: start over */ }
    const now = Date.now();
    if (now - t < OUTBOX_ATTEMPT_SPACING_MS) return n;
    writeFileSync(side, JSON.stringify({ n: ++n, t: now }), { mode: 0o600 });
    return n;
  }

  /** The hub answered with something other than a 5xx: earlier failures were not the write's fault, so the count starts over. */
  private resetAttempts(file: string): void {
    rmSync(join(this.outboxDir!, `${file}.attempts`), { force: true });
  }

  /**
   * Send saved writes oldest first, until none is left or the hub cannot take one yet (it stays first, so order holds). A write the
   * hub refuses (4xx, read-only, permission) moves to rejected/ and the next one goes. 401 keeps the write: a token fault is fixable.
   * Each write is read, sent and removed under flush.lock, so a second process replays nothing twice; when another holds it, this
   * flush leaves the queue to that one. A write the hub itself fails with a 5xx (500, 501, 505+) OUTBOX_MAX_ATTEMPTS times is moved
   * to rejected/ (tries are counted at least OUTBOX_ATTEMPT_SPACING_MS apart, and any non-5xx answer resets the count); no answer,
   * 408/429 and 502/503/504 (a proxy or gateway in front of a hub that is down) never count.
   */
  async flush(): Promise<void> {
    const dir = this.outboxDir;
    if (!dir || !this.configured || flushingDirs.has(dir)) return;
    flushingDirs.add(dir);
    try {
      let swept = false;
      for (;;) {
        let release: (() => void) | undefined;
        try {
          release = tryOutboxLock(dir);
        } catch (e) {
          if (errno(e) === "ENOENT") return; // no outbox dir: nothing was ever queued
          throw e;
        }
        if (!release) return;
        try {
          if (!swept) {
            this.sweepTmp(dir);
            swept = true;
          }
          const f = this.pending()[0];
          if (!f) return;
          let w: QueuedWrite;
          try {
            w = JSON.parse(readFileSync(join(dir, f), "utf8")) as QueuedWrite;
          } catch (e) {
            if (errno(e) === "ENOENT") continue;
            this.reject(f, `unreadable: ${e instanceof Error ? e.message : e}`);
            continue;
          }
          const r = await this.send(w.method, w.path, w.body, w.key);
          if ("unreachable" in r) {
            const s = r.status ?? 0;
            if (s >= 500 && ![502, 503, 504].includes(s) && this.countAttempt(f) >= OUTBOX_MAX_ATTEMPTS) {
              this.reject(f, `the hub failed it ${OUTBOX_MAX_ATTEMPTS} times (last: ${r.error instanceof Error ? r.error.message : r.error})`);
              continue;
            }
            if (s && s < 500) this.resetAttempts(f); // 408/429: an answer, not a failure of this write
            return;
          }
          if (!r.ok && r.status === 401) {
            this.resetAttempts(f);
            return;
          }
          if (r.ok) {
            rmSync(join(dir, f), { force: true });
            rmSync(join(dir, `${f}.attempts`), { force: true });
          } else this.reject(f, String(r.data.error ?? r.data.code ?? `HTTP ${r.status}`));
        } finally {
          release();
        }
      }
    } finally {
      flushingDirs.delete(dir);
    }
  }

  /**
   * The name's time: max(now, last + 1), kept in `<dir>/clock`, so it never goes backwards (a clock step, another process) and
   * is unique under the lock. pid and a per-process seq follow it only as a tiebreak for a save made without the lock.
   */
  private stamp(dir: string): string {
    const clock = join(dir, "clock");
    let last = 0;
    try { last = Number(readFileSync(clock, "utf8")) || 0; } catch { /* first save */ }
    const t = Math.max(Date.now(), last + 1);
    const tmp = join(dir, `.clock-${process.pid}.tmp`);
    writeFileSync(tmp, String(t), { mode: 0o600 });
    renameSync(tmp, clock);
    return `${String(t).padStart(15, "0")}-${String(process.pid).padStart(10, "0")}-${String(seq++ % 1_000_000).padStart(6, "0")}`;
  }

  /**
   * Durable: written to a temp file, fsynced, then renamed into place, under flush.lock (waits up to LOCK_WAIT_MS for a holder
   * sending a write; past that it saves anyway rather than lose the write, ordered by the clock as far as it can see).
   */
  private async enqueue(w: QueuedWrite): Promise<void> {
    const dir = this.outboxDir!;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let release = tryOutboxLock(dir);
    for (const until = Date.now() + LOCK_WAIT_MS; !release && Date.now() < until; release = tryOutboxLock(dir)) await sleep(25);
    if (!release) console.warn("[work-outbox] flush.lock stayed held; saving a write without it");
    try {
      const name = `${this.stamp(dir)}-${w.key}.json`;
      const tmp = join(dir, `.${w.key}.tmp`);
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify(w));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, join(dir, name));
    } finally {
      release?.();
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured) {
      throw new Error("Work API not configured (WORK_ENDPOINT / WORK_TOKEN missing)");
    }
    const write = method !== "GET" && !!this.outboxDir;
    // Sent on the live first attempt too: if the hub applies it but the answer is lost (a timeout), the queued resend carries the
    // same key and is not applied twice. Costs the hub one store line per write, bounded by its 7-day expiry.
    const key = write ? randomUUID() : undefined;
    if (write) {
      await this.flush(); // earlier saved writes go first
      // Anything still waiting (the hub is down, or another flush is sending): this write queues behind it, never ahead.
      if (this.pending().length) {
        await this.enqueue({ key: key!, method, path, body });
        throw new WorkQueuedError();
      }
    }
    const r = await this.send(method, path, body, key);
    if ("unreachable" in r) {
      if (write) {
        await this.enqueue({ key: key!, method, path, body });
        throw new WorkQueuedError();
      }
      throw r.error;
    }
    if (!r.ok) {
      // The hub's work store is read-only (e.g. a VPS wolf behind a sandboxed hubd): say it in plain words, the model must not retry.
      if (r.data.code === "work_store_read_only") throw new WorkStoreReadOnlyError();
      if (r.data.code === "work_store_permission_denied") throw new WorkStorePermissionError();
      throw new Error(String(r.data.error ?? `HTTP ${r.status}`));
    }
    return r.data as T;
  }

  async create(input: CreateWorkInput): Promise<{ id: string; item: WorkItem; assignedTo?: string }> {
    return this.request("POST", "", input);
  }

  async get(id: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("GET", `/${id}`);
    return res.item;
  }

  /** Fetch an item along with its materialized body. Body is null when the
   *  work .md hasn't been written yet (freshly created, never committed). */
  async getWithBody(id: string): Promise<{ item: WorkItem; body: string | null }> {
    return this.request<{ item: WorkItem; body: string | null }>("GET", `/${id}`);
  }

  async query(q: WorkQuery = {}): Promise<WorkItem[]> {
    const params = new URLSearchParams();
    if (q.domain) params.set("domain", q.domain);
    if (q.kind) params.set("kind", q.kind);
    if (q.stage) params.set("stage", q.stage);
    if (q.assignee) params.set("assignee", q.assignee);
    if (q.area) params.set("area", q.area);
    if (q.partOf) params.set("partOf", q.partOf);
    const qs = params.toString();
    const res = await this.request<{ items: WorkItem[] }>("GET", qs ? `?${qs}` : "");
    return res.items;
  }

  async stage(id: string, to: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { stage: to });
    return res.item;
  }

  async note(id: string, text: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { note: text });
    return res.item;
  }

  async graduate(id: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("POST", `/${id}/graduate`);
    return res.item;
  }

  async retitle(id: string, title: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { title });
    return res.item;
  }

  async setCriteria(id: string, criteria: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { successCriteria: criteria });
    return res.item;
  }

  async assign(id: string, assignee: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { assignee });
    return res.item;
  }

  async move(id: string, to: string): Promise<WorkItem> {
    return (await this.moveReport(id, to)).item;
  }

  /** Move, and report a handoff: a task moved under another wolf's feature is also assigned to that wolf (`reassigned`). */
  async moveReport(id: string, to: string | null): Promise<{ item: WorkItem; reassigned: { id: string; from: string | null; to: string }[] }> {
    const res = await this.request<{ item: WorkItem; reassigned?: { id: string; from: string | null; to: string }[] }>("PATCH", `/${id}`, { moveTo: to });
    return { item: res.item, reassigned: res.reassigned ?? [] };
  }

  async link(id: string, rel: string, target: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { link: { rel, target } });
    return res.item;
  }

  async unlink(id: string, rel: string, target: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { unlink: { rel, target } });
    return res.item;
  }

  /** Mark or unmark an initiative as standing (never completes). */
  async setStanding(id: string, standing: boolean): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { standing });
    return res.item;
  }

  /** Pin a task to a calendar slot. Pass scheduledFor=null to unschedule. */
  async schedule(
    id: string,
    scheduledFor: string | null,
    durationMinutes?: number | null,
  ): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, {
      schedule: { scheduledFor, durationMinutes },
    });
    return res.item;
  }

  async updateBody(id: string, body: string): Promise<WorkItem> {
    const res = await this.request<{ item: WorkItem }>("PATCH", `/${id}`, { body });
    return res.item;
  }

  /**
   * The item and everything under it, depth first. Reads the root with get() and each level with query({ partOf }),
   * siblings in parallel: the unfiltered list is ~1.6 MB / ~4 s on the hub, over the 3 s limit, and grows with every item.
   * Scoped reads stay small however many items exist, so the limit is left alone.
   */
  async getTree(rootId: string): Promise<WorkItem[]> {
    let root: WorkItem;
    try {
      root = await this.get(rootId);
    } catch {
      return [];
    }
    const seen = new Set<string>([rootId]);
    const walk = async (parentId: string): Promise<WorkItem[]> => {
      const kids = (await this.query({ partOf: parentId })).filter((k) => typeof k.id === "string" && !seen.has(k.id));
      for (const k of kids) seen.add(k.id as string);
      const below = await Promise.all(kids.map((k) => walk(k.id as string)));
      return kids.flatMap((k, i) => [k, ...below[i]!]);
    };
    return [root, ...(await walk(rootId))];
  }

  async ensureInbox(domain: string, assignee: string): Promise<WorkItem> {
    const items = await this.query({ domain });
    const inbox = items.find((i) => i.container && i.kind === "feature");
    if (inbox) return inbox;
    const result = await this.create({
      kind: "feature" as any,
      domain,
      title: "Inbox",
      assignee,
      // Without the flag this Inbox is an ordinary feature that the lookup
      // above never finds, so every move-to-Inbox would create another one.
      container: true,
    });
    return result.item;
  }

  async delete(id: string): Promise<string[]> {
    const res = await this.request<{ deleted: string[] }>("DELETE", `/${id}`);
    return res.deleted;
  }
}

/** The Work API as the Outcomes rollup needs it (both runtimes ship tasks through this). */
export function rollupClientFor(client: WorkClient): RollupClient {
  return {
    async query({ ids }) {
      const out = [];
      for (const id of ids ?? []) {
        try {
          const i = await client.get(id);
          out.push({
            id: i.id as string,
            kind: i.kind as string,
            title: i.title,
            partOf: (i.partOf as string | null) ?? null,
            updated: i.updated as string,
            successCriteria: i.successCriteria ?? null,
            container: i.container === true,
          });
        } catch { /* gone: the rollup treats it as no parent */ }
      }
      return out;
    },
    async getBody(id) {
      return (await client.getWithBody(id)).body ?? "";
    },
    async updateBody(id, body) {
      await client.updateBody(id, body);
    },
  };
}

/** Ship an item and fold it into its feature's Outcomes. A failed rollup never blocks the ship. */
export async function shipAndRollup(
  client: WorkClient,
  id: string,
  rollup: (client: RollupClient, id: string) => Promise<unknown>,
  onError?: (err: unknown) => void,
): Promise<WorkItem> {
  const item = await client.stage(id, "shipped");
  try {
    await rollup(rollupClientFor(client), id);
  } catch (err) {
    onError?.(err);
  }
  return item;
}
