/**
 * The folded work ledger for the Work API proxy, cached by the ledger file's stat signature (mtime:size:inode).
 * A fold of a 6,000-event ledger costs ~10 ms of CPU; a burst of item reads used to pay it once per request.
 * Every ledger append changes the size, so a write is seen on the next read. The returned map is shared: READ-ONLY.
 */
import { statSync } from "node:fs";
import { foldWork, readWorkLedger, type WorkId, type WorkItem } from "@wolfpack/kb/client";
import { workLedgerFile, type KbRoots } from "@wolfpack/kb/shared";

const cache = new Map<string, { sig: string; state: ReadonlyMap<WorkId, Readonly<WorkItem>> }>();

export function cachedWorkState(roots: KbRoots): ReadonlyMap<WorkId, Readonly<WorkItem>> {
  const file = workLedgerFile(roots);
  let sig: string | undefined;
  try {
    const st = statSync(file);
    sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    cache.delete(file);
  }
  const hit = sig ? cache.get(file) : undefined;
  if (hit && hit.sig === sig) return hit.state;
  const state = foldWork(readWorkLedger(roots));
  if (sig) {
    if (cache.size > 16) cache.clear();
    cache.set(file, { sig, state });
  }
  return state;
}
