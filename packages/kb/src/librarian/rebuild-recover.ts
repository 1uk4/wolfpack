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
export function restoreAndRender(roots: KbRoots, stamp: string, hooks: Pick<CommitHooks, "vectorOf"> = {}): RestoreResult & { domain: string } {
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

/**
 * recoverAndRender for the sweep and the tick: it never throws. A failure is reported through `notify`, the sweep
 * carries on, and the next run retries; after RECOVER_MAX_FAILURES consecutive failures the journal is moved to
 * .rebuild-journal.bad (quarantined) so a poisoned journal cannot block every future sweep. Returns the writes finished.
 */
export function tryRecoverAndRender(roots: KbRoots, notify?: (msg: string) => void): number {
  if (!existsSync(rebuildJournalFile(roots))) return 0;
  try {
    const n = recoverAndRender(roots, notify);
    rmSync(failuresFile(roots), { force: true });
    return n;
  } catch (err) {
    const count = readFailures(roots) + 1;
    const why = err instanceof Error ? err.message : String(err);
    if (count >= RECOVER_MAX_FAILURES) {
      try { renameSync(rebuildJournalFile(roots), rebuildBadJournalFile(roots)); } catch { /* already gone */ }
      rmSync(failuresFile(roots), { force: true });
      notify?.(`rebuild recovery failed ${count} times in a row (${why}); the journal was moved to ${rebuildBadJournalFile(roots)} and the sweep continues. Check the KB with \`status\`; restore with \`rebuild --restore\` if needed`);
    } else {
      try { writeFileSync(failuresFile(roots), String(count)); } catch { /* best effort */ }
      notify?.(`rebuild recovery failed (${count}/${RECOVER_MAX_FAILURES}): ${why}; continuing, will retry next run`);
    }
    return 0;
  }
}
