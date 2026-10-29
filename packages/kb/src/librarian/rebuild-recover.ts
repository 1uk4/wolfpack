/**
 * rebuild-recover — finish an interrupted rebuild commit (under the KB lock) and
 * re-render the registry, digest and INDEX the commit would have rendered.
 * Shared by the sweep, the tick and the rebuild.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KbRoots } from "../shared/index.js";
import { recoverRebuild, pendingJournalDomain, rebuildJournalFile, rebuildBadJournalFile, restoreRebuild, rebuildOldValuesFile, type RestoreResult, type CommitHooks } from "./rebuild-commit.js";
import { readLedger, foldRegistry } from "./ledger.js";
import { renderRegistry } from "./registry.js";
import { renderDomainDigest, renderDomainIndex } from "./domains.js";

/** Returns the writes finished (0 when there was nothing to do). Notifies only when something was recovered or the journal was bad. */
export function recoverAndRender(roots: KbRoots, notify?: (msg: string) => void): number {
  const domain = pendingJournalDomain(roots);
  const n = recoverRebuild(roots, { notify });
  if (n > 0) {
    notify?.(`recovered an interrupted rebuild (${n} write(s) finished)`);
    renderRegistry(roots, foldRegistry(readLedger(roots)));
    if (domain) { renderDomainDigest(roots, domain); renderDomainIndex(roots, domain); }
  }
  return n;
}

/** Restore one domain from a rebuild backup, then re-render the registry, digest and INDEX. Caller holds the KB lock. */
export function restoreAndRender(roots: KbRoots, stamp: string, hooks: Pick<CommitHooks, "vectorOf" | "notify" | "rename"> = {}): RestoreResult & { domain: string } {
  const r = restoreRebuild(roots, stamp, hooks);
  const domain = JSON.parse(readFileSync(rebuildOldValuesFile(roots, stamp), "utf-8")).domain as string;
  renderRegistry(roots, foldRegistry(readLedger(roots)));
  renderDomainDigest(roots, domain);
  renderDomainIndex(roots, domain);
  return { ...r, domain };
}

/** Consecutive failed recoveries before the journal is quarantined. */
export const RECOVER_MAX_FAILURES = 3;
const failuresFile = (r: KbRoots) => join(r.denLocal, ".rebuild-recover-failures");
const readFailures = (r: KbRoots): number => { try { return Number(readFileSync(failuresFile(r), "utf-8")) || 0; } catch { return 0; } };

export interface RecoverOutcome {
  /** Writes finished (0 when there was nothing to do or recovery failed). */
  n: number;
  /** Set when a journal is present and recovery failed this run: the caller must SKIP the run (the tree may be half-committed). */
  failed?: string;
  /** True when this failure was the last allowed: the journal was just moved to .rebuild-journal.bad. */
  quarantined?: boolean;
}

/** The note shown while an operator has not yet dealt with a quarantined journal; undefined when there is none. */
export function badJournalNote(roots: KbRoots): string | undefined {
  return existsSync(rebuildBadJournalFile(roots))
    ? `a quarantined rebuild journal is present (${rebuildBadJournalFile(roots)}): the last rebuild may be half-applied. Inspect it, run \`rebuild --restore <ts> --yes\` if needed, then delete the file`
    : undefined;
}

/**
 * recoverAndRender for the sweep and the tick; it never throws. While a journal is present and recovery FAILS the
 * result says so (`failed`) and the caller must skip the run instead of placing entries into a half-committed tree.
 * One run = one attempt: the tick recovers and, on failure, returns without calling the sweep (the sweep only recovers
 * when it is the entry point), so the counter counts runs. After RECOVER_MAX_FAILURES failed runs the journal is moved
 * to .rebuild-journal.bad; that run is still skipped, later runs proceed and report the quarantine (badJournalNote)
 * until an operator removes the file.
 */
export function tryRecoverAndRender(roots: KbRoots, notify?: (msg: string) => void): RecoverOutcome {
  if (!existsSync(rebuildJournalFile(roots))) return { n: 0 };
  try {
    const n = recoverAndRender(roots, notify);
    rmSync(failuresFile(roots), { force: true });
    // an unreadable journal is quarantined inside recoverRebuild (n = 0, no journal left): that is a stop, not a success
    if (!existsSync(rebuildJournalFile(roots)) && badJournalNote(roots) && n === 0) return { n, failed: "the rebuild journal was unreadable and has been quarantined", quarantined: true };
    return { n };
  } catch (err) {
    const count = readFailures(roots) + 1;
    const why = err instanceof Error ? err.message : String(err);
    if (count >= RECOVER_MAX_FAILURES) {
      try { renameSync(rebuildJournalFile(roots), rebuildBadJournalFile(roots)); } catch { /* already gone */ }
      rmSync(failuresFile(roots), { force: true });
      notify?.(`rebuild recovery failed ${count} runs in a row (${why}); the journal was moved to ${rebuildBadJournalFile(roots)}. This run is skipped; later runs continue, but check the KB with \`status\` (restore with \`rebuild --restore\` if needed)`);
      return { n: 0, failed: `rebuild recovery failed ${count} runs in a row; journal quarantined`, quarantined: true };
    }
    try { writeFileSync(failuresFile(roots), String(count)); } catch { /* best effort */ }
    notify?.(`rebuild recovery failed (${count}/${RECOVER_MAX_FAILURES}): ${why}; this run is skipped (the tree may be half-committed), will retry next run`);
    return { n: 0, failed: `rebuild recovery failed (${count}/${RECOVER_MAX_FAILURES}): ${why}` };
  }
}
