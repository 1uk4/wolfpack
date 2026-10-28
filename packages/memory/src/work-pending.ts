/**
 * Bookkeeping for tagged observations that cannot be folded into a Record yet, shared by the durable and pi paths.
 * Everything lives under `<root>/.memory/pool/` (root = the wolf's den): the observation archive and `work-state.json`.
 * State is advisory: any read/write failure degrades to "no state" and never blocks consolidation.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { observationHash } from "./observation-id.js";

export type PendingCause = "work-api-unavailable" | "consolidation-failed";

/** First retry delay for a pending group; doubles per failed attempt up to the cap. */
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_CAP_MS = 6 * 3_600_000;
/** An item must stay 404 this long, or across this many runs, before its observations are discarded. */
export const MISSING_GRACE_MS = 10 * 60_000;
export const MISSING_GRACE_RUNS = 2;

export const poolDir = (root: string): string => join(root, ".memory", "pool");
/** The old discard log (ticket 1): still read, no longer written; its entries are folded into the archive. */
export const discardLogPath = (root: string): string => join(poolDir(root), "discarded.jsonl");
export const archivePath = (root: string): string => join(poolDir(root), "archive.jsonl");

/**
 * What became of an observation that left the pool:
 * written (folded into a Record), discarded (its item is archived or deleted), den (folded into a den or
 * session topic), promoted (its topic was distilled to the KB).
 */
export type ArchiveOutcome = "written" | "discarded" | "den" | "promoted";

/** One line of `.memory/pool/archive.jsonl`: the observation as it was, and where it went. Append-only. */
export interface ArchiveEntry {
  id: string;
  timestamp: string;
  recordedAt: string;
  content: string;
  work?: string;
  feature?: string;
  outcome: ArchiveOutcome;
  /** written: the work item holding the Record · discarded: the reason · den / promoted: the topic id(s). */
  target: string;
  /** When it was archived (ISO). */
  at: string;
}

export interface ArchiveItem {
  obs: { timestamp?: string; recordedAt?: string; content: string; work?: string; feature?: string };
  /** The observation's id (observationIds over the pool); absent: the hash without ordinal. */
  id?: string;
  outcome: ArchiveOutcome;
  target: string;
}

/**
 * Append observations that left the pool to the archive; guarded: a failed append is reported, never thrown.
 * An observation already archived with the same outcome is not written twice (a settle that failed halfway reruns safely).
 */
export function appendArchive(root: string, items: ArchiveItem[], onError?: (msg: string) => void): boolean {
  if (items.length === 0) return true;
  try {
    mkdirSync(poolDir(root), { recursive: true });
    const at = new Date().toISOString();
    const have = new Set(readArchive(root).map((e) => `${e.id}\u0000${e.outcome}`));
    const lines: string[] = [];
    for (const { obs, id, outcome, target } of items) {
      const oid = id ?? observationHash(obs);
      const key = `${oid}\u0000${outcome}`;
      if (have.has(key)) continue;
      have.add(key);
      const e: ArchiveEntry = {
        id: oid,
        timestamp: obs.timestamp ?? "",
        recordedAt: obs.recordedAt ?? "",
        content: obs.content,
        ...(obs.work ? { work: obs.work } : {}),
        ...(obs.feature ? { feature: obs.feature } : {}),
        outcome,
        target,
        at,
      };
      lines.push(JSON.stringify(e) + "\n");
    }
    if (lines.length > 0) appendFileSync(archivePath(root), lines.join(""));
    return true;
  } catch (err) {
    onError?.(`observation archive not written: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Append discarded observations with their reason (an archive entry with outcome `discarded`). */
export function appendDiscarded(root: string, items: Array<{ obs: ArchiveItem["obs"]; id?: string; reason: string }>, onError?: (msg: string) => void): boolean {
  return appendArchive(root, items.map(({ obs, id, reason }) => ({ obs, id, outcome: "discarded" as const, target: reason })), onError);
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).flatMap((l) => {
      try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

/**
 * The archive, oldest first. The old `discarded.jsonl` is read too (its lines become `discarded` entries) when it
 * exists and the archive does not already hold the observation.
 */
export function readArchive(root: string): ArchiveEntry[] {
  const out = readJsonl(archivePath(root)) as unknown as ArchiveEntry[];
  const legacy = readJsonl(discardLogPath(root));
  if (legacy.length === 0) return out;
  const have = new Set(out.map((e) => `${e.id}\u0000${e.outcome}`));
  for (const l of legacy) {
    const o = { timestamp: String(l.timestamp ?? ""), recordedAt: String(l.recordedAt ?? ""), content: String(l.content ?? "") };
    const id = observationHash(o);
    if (have.has(`${id}\u0000discarded`)) continue;
    out.push({
      id,
      ...o,
      ...(typeof l.work === "string" ? { work: l.work } : {}),
      ...(typeof l.feature === "string" ? { feature: l.feature } : {}),
      outcome: "discarded",
      target: String(l.reason ?? ""),
      at: String(l.discardedAt ?? ""),
    });
  }
  return out;
}

/** An archived observation by id (any outcome; the last entry wins). */
export const findArchived = (root: string, id: string): ArchiveEntry | undefined => readArchive(root).filter((e) => e.id === id).pop();

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
