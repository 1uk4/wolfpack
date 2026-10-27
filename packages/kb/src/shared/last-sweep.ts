/**
 * last-sweep — the last finished sweep, persisted to `<denLocal>/sweep-last.json`, so the last-run time and counts
 * survive idle ticks and restarts (`kb_sweep_status`, the pipeline view). Written by the sweep manager.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KbRoots } from "./paths.js";

export interface LastSweep {
  /** ISO. */
  startedAt: string;
  /** ISO. */
  finishedAt: string;
  processed: number;
  created: number;
  merged: number;
  rejected: number;
  parked: number;
  remaining: number;
  durationMs: number;
  /** One line; set when the run threw. */
  error?: string;
}

export const lastSweepFile = (roots: KbRoots) => join(roots.denLocal, "sweep-last.json");

export function writeLastSweep(roots: KbRoots, last: LastSweep): void {
  const file = lastSweepFile(roots);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(last, null, 2));
  renameSync(tmp, file);
}

/** The persisted last sweep; null when none, or the file is unreadable / malformed. */
export function readLastSweep(roots: KbRoots): LastSweep | null {
  try {
    const v = JSON.parse(readFileSync(lastSweepFile(roots), "utf-8")) as Partial<LastSweep>;
    if (typeof v.startedAt !== "string" || typeof v.finishedAt !== "string") return null;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    return {
      startedAt: v.startedAt,
      finishedAt: v.finishedAt,
      processed: n(v.processed),
      created: n(v.created),
      merged: n(v.merged),
      rejected: n(v.rejected),
      parked: n(v.parked),
      remaining: n(v.remaining),
      durationMs: n(v.durationMs),
      ...(typeof v.error === "string" ? { error: v.error } : {}),
    };
  } catch {
    return null;
  }
}
