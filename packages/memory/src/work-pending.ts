/**
 * Bookkeeping for tagged observations that cannot be folded into a Record yet, shared by the durable and pi paths.
 * Everything lives under `<root>/.memory/pool/` (root = the wolf's den): the discard log and `work-state.json`.
 * State is advisory: any read/write failure degrades to "no state" and never blocks consolidation.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PendingCause = "work-api-unavailable" | "consolidation-failed";

/** First retry delay for a pending group; doubles per failed attempt up to the cap. */
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_CAP_MS = 6 * 3_600_000;
/** An item must stay 404 this long, or across this many runs, before its observations are discarded. */
export const MISSING_GRACE_MS = 10 * 60_000;
export const MISSING_GRACE_RUNS = 2;

export const poolDir = (root: string): string => join(root, ".memory", "pool");
export const discardLogPath = (root: string): string => join(poolDir(root), "discarded.jsonl");

/** Append discarded observations with their reason; guarded: a failed append is reported, never thrown. */
export function appendDiscarded(root: string, items: Array<{ obs: object; reason: string }>, onError?: (msg: string) => void): boolean {
  if (items.length === 0) return true;
  try {
    mkdirSync(poolDir(root), { recursive: true });
    const at = new Date().toISOString();
    appendFileSync(discardLogPath(root), items.map(({ obs, reason }) => JSON.stringify({ ...obs, discardedAt: at, reason }) + "\n").join(""));
    return true;
  } catch (err) {
    onError?.(`discard log not written: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export interface PendingEntry {
  firstPendingAt: number;
  tries: number;
  nextAttemptAt: number;
  cause: PendingCause;
  /** Work API answered 404 for the item since this time / for this many runs. */
  missingSince?: number;
  missingRuns?: number;
}
type StateFile = Record<string, PendingEntry>;

export class WorkPendingState {
  private data: StateFile = {};
  private dirty = false;
  private file: string;

  /** `root` undefined: in-memory only (nothing read or written). */
  constructor(root: string | undefined, private now: () => number = Date.now) {
    this.file = root ? join(poolDir(root), "work-state.json") : "";
    if (root) try { this.data = JSON.parse(readFileSync(this.file, "utf-8")) as StateFile; } catch { this.data = {}; }
  }

  /** False while the group waits out its backoff. */
  due(key: string): boolean {
    const e = this.data[key];
    return !e || e.nextAttemptAt <= this.now();
  }

  entry(key: string): PendingEntry | undefined {
    return this.data[key];
  }

  pending(key: string, cause: PendingCause): void {
    const e = this.data[key];
    const tries = (e?.tries ?? 0) + 1;
    this.data[key] = { ...e, firstPendingAt: e?.firstPendingAt ?? this.now(), tries, cause, nextAttemptAt: this.now() + Math.min(BACKOFF_BASE_MS * 2 ** (tries - 1), BACKOFF_CAP_MS) };
    this.dirty = true;
  }

  /** Written or discarded: forget the group. */
  clear(key: string): void {
    if (key in this.data) { delete this.data[key]; this.dirty = true; }
  }

  /** The item answered 404. True once it has stayed missing long enough (or across enough runs) to discard. */
  missing(key: string): boolean {
    const e = this.data[key];
    const since = e?.missingSince ?? this.now();
    const runs = (e?.missingRuns ?? 0) + 1;
    this.data[key] = { firstPendingAt: e?.firstPendingAt ?? this.now(), tries: e?.tries ?? 0, cause: e?.cause ?? "work-api-unavailable", nextAttemptAt: e?.nextAttemptAt ?? 0, missingSince: since, missingRuns: runs };
    this.dirty = true;
    return runs >= MISSING_GRACE_RUNS || this.now() - since >= MISSING_GRACE_MS;
  }

  save(): void {
    if (!this.dirty || !this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch { /* advisory */ }
  }
}

/** The pending summary the observations route serves: keys waiting, and the oldest wait. */
export function readPendingSummary(root: string, now: number = Date.now()): { keys: Record<string, PendingCause>; oldestAgeMs?: number } {
  const st = new WorkPendingState(root, () => now);
  const keys: Record<string, PendingCause> = {};
  let oldest: number | undefined;
  for (const [k, e] of Object.entries((st as unknown as { data: StateFile }).data)) {
    if (e.tries === 0) continue;
    keys[k] = e.cause;
    oldest = Math.min(oldest ?? e.firstPendingAt, e.firstPendingAt);
  }
  return { keys, ...(oldest !== undefined ? { oldestAgeMs: now - oldest } : {}) };
}
