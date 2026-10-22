/**
 * drain — one Telegram message when a backlog of contributions has been worked
 * off. The sweep handles one item per tick, so counts accumulate in a small
 * JSON file in KB_OPS (written atomically, next to sweep-backoff.json): the
 * launchd/CLI path is a new process every minute and the harness timer shares
 * the same file. On the first tick that leaves the inbox empty with a non-zero
 * tally, the message goes out through the `alert` callback and the file is
 * removed. An idle tick with nothing accumulated does nothing at all.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KbRoots } from "../shared/index.js";
import type { SweepResult } from "./sweep.js";
import type { Alert } from "./backoff.js";

/** Contents of KB_OPS/sweep-drain.json. Absent file = nothing accumulated. */
export interface DrainState {
  merged: number;
  created: number;
  parked: number;
  /** Failed attempts: the item stayed queued and is counted again when it finishes. */
  failed: number;
  /** Items moved to unclassified (no domain). */
  unclassified: number;
  /** Items skipped as older than the live entry. */
  rejected: number;
  /** ISO time the first item of this backlog was processed. */
  since: string;
}

export const drainFile = (roots: KbRoots) => join(roots.opsRoot, "sweep-drain.json");

const COUNTS = ["merged", "created", "parked", "failed", "unclassified", "rejected"] as const;

export function readDrain(roots: KbRoots): DrainState | null {
  try {
    const s = JSON.parse(readFileSync(drainFile(roots), "utf-8")) as DrainState;
    if (typeof s.since !== "string") return null;
    for (const k of COUNTS) if (typeof s[k] !== "number") s[k] = 0;
    return s;
  } catch {
    return null;
  }
}

function writeDrain(roots: KbRoots, s: DrainState): void {
  mkdirSync(roots.opsRoot, { recursive: true });
  const tmp = `${drainFile(roots)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, drainFile(roots));
}

/** Items that left the inbox. Failed attempts are retries of an item that is
 *  counted again when it finally merges or parks, so they stay out of the total. */
const itemsDone = (s: DrainState) => s.merged + s.created + s.parked + s.unclassified + s.rejected;
const total = (s: DrainState) => itemsDone(s);

/** "sweep: inbox drained — 7 processed (5 merged, 2 created, 0 parked, 0 failed) since 19:03" */
export function formatDrain(s: DrainState): string {
  const parts = [`${s.merged} merged`, `${s.created} created`, `${s.parked} parked`, `${s.failed} failed`];
  if (s.unclassified > 0) parts.push(`${s.unclassified} unclassified`);
  if (s.rejected > 0) parts.push(`${s.rejected} skipped`);
  const t = new Date(s.since);
  const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return `sweep: inbox drained — ${total(s)} processed (${parts.join(", ")}) since ${hhmm}`;
}

/** Fold one tick's result into the persisted tally. No-op when it did no work. */
export function noteDrainProgress(roots: KbRoots, r: SweepResult, nowMs = Date.now()): void {
  const delta = {
    merged: r.merged,
    created: r.created,
    parked: r.parked.length,
    failed: r.failures.length,
    unclassified: r.unclassified,
    rejected: r.rejected,
  };
  if (COUNTS.every((k) => delta[k] === 0)) return;
  const prev = readDrain(roots);
  const next: DrainState = prev ?? { merged: 0, created: 0, parked: 0, failed: 0, unclassified: 0, rejected: 0, since: new Date(nowMs).toISOString() };
  for (const k of COUNTS) next[k] += delta[k];
  writeDrain(roots, next);
}

/**
 * Call when the inbox is empty: send the one message if anything accumulated,
 * then reset. The state is cleared first so a failing alert can't repeat it.
 */
export async function flushDrain(roots: KbRoots, alert?: Alert): Promise<boolean> {
  const s = readDrain(roots);
  if (!s) return false;
  rmSync(drainFile(roots), { force: true });
  if (total(s) === 0) return false; // only failed attempts so far: wait for the item to finish
  try {
    await alert?.(formatDrain(s));
  } catch (e) {
    console.error("sweep: alert failed:", e instanceof Error ? e.message : e);
  }
  return true;
}
