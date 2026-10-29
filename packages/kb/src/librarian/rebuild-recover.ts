/**
 * rebuild-recover — finish an interrupted rebuild commit (under the KB lock) and
 * re-render the registry, digest and INDEX the commit would have rendered.
 * Shared by the sweep, the tick and the rebuild.
 */
import type { KbRoots } from "../shared/index.js";
import { recoverRebuild, pendingJournalDomain } from "./rebuild-commit.js";
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
