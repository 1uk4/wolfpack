/**
 * Sweep commit intent — closes the window between "entry is live" and "its ledger events are appended".
 *
 * sweep.ts writes the intent (hash, entry, the exact events) BEFORE the entry commit and clears it right after the ledger
 * append. A crash in between leaves the file; the next tick calls replayIntent (under the KB lock, before it drains the
 * inbox): the events are appended only when the hash is NOT yet in the ledger AND the entry file exists; otherwise the intent
 * is discarded (the commit never happened, or the append did). Dedupe stays "hash seen in the ledger".
 *
 * The file lives in opsRoot (per-wolf lanes / the hub's kb/ops), which is not Syncthing-mirrored and not part of a hub export
 * (export.ts includes only kb/ops/contributions).
 */
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "@wolfpack/engine";
import { entriesDir, type KbEvent, type KbRoots } from "../shared/index.js";
import { appendLedger, readLedger, seenHashes } from "./ledger.js";

export interface CommitIntent {
  hash: string;
  entryId: string;
  domain: string;
  events: KbEvent[];
  /** sha256 of the entry file text the commit writes; replay requires the live file to match it (a merge whose write never landed leaves the OLD file). Absent when the commit writes nothing. */
  expect?: string;
  /** entry_written events for entryId in the ledger when the intent was written. A larger count at replay means the commit path itself logged one (the hub's commitKb); the intent's own entry_written is then dropped so it is not counted twice. */
  written?: number;
}

const writtenCount = (log: KbEvent[], entryId: string): number => log.filter((e) => e.t === "entry_written" && (e as { entryId?: string }).entryId === entryId).length;

export const intentDigest = (text: string): string => createHash("sha256").update(text).digest("hex");

export { writtenCount as intentWrittenCount };
export const intentFile = (roots: KbRoots): string => join(roots.opsRoot, "pending-commit.json");

/** Atomic write (temp file + rename). */
export function writeIntent(roots: KbRoots, intent: CommitIntent): void {
  atomicWrite(intentFile(roots), JSON.stringify({ v: 1, ...intent }));
}

export function clearIntent(roots: KbRoots): void {
  rmSync(intentFile(roots), { force: true });
}

export type ReplayResult = "none" | "recorded" | "discarded";

/**
 * Finish or drop a leftover intent. `append` is the sweep's ledger writer (the hub passes its own); it defaults to appendLedger.
 * If the append throws, the intent is KEPT (the next tick retries) and the error propagates.
 */
export async function replayIntent(
  roots: KbRoots,
  opts: { append?: (events: KbEvent[]) => void | Promise<void>; notify?: (m: string) => void } = {}
): Promise<ReplayResult> {
  const file = intentFile(roots);
  if (!existsSync(file)) return "none";
  let intent: CommitIntent;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    if (!raw || typeof raw.hash !== "string" || typeof raw.entryId !== "string" || typeof raw.domain !== "string" || !Array.isArray(raw.events)) throw new Error("bad shape");
    intent = { hash: raw.hash, entryId: raw.entryId, domain: raw.domain, events: raw.events, ...(typeof raw.expect === "string" ? { expect: raw.expect } : {}), ...(typeof raw.written === "number" ? { written: raw.written } : {}) };
  } catch (err) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, aside);
    } catch {
      rmSync(file, { force: true });
    }
    const msg = `sweep: corrupt commit intent moved aside to ${aside}: ${err instanceof Error ? err.message : String(err)}`;
    (opts.notify ?? ((m) => console.warn(m)))(msg);
    return "discarded";
  }
  const ledger = readLedger(roots);
  const seen = seenHashes(ledger).has(intent.hash);
  const entryPath = join(entriesDir(roots, intent.domain), `${intent.entryId}.md`);
  const live = existsSync(entryPath) && (intent.expect === undefined || intentDigest(readFileSync(entryPath, "utf-8")) === intent.expect);
  if (seen || !live) {
    clearIntent(roots);
    return "discarded";
  }
  let events = intent.events;
  if (intent.written !== undefined && writtenCount(ledger, intent.entryId) > intent.written) {
    const i = events.findIndex((e) => e.t === "entry_written" && (e as { entryId?: string }).entryId === intent.entryId);
    if (i >= 0) events = events.filter((_, j) => j !== i);
  }
  await (opts.append ?? ((e) => appendLedger(roots, e)))(events);
  clearIntent(roots);
  return "recorded";
}
