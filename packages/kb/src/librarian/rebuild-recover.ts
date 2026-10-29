/**
 * rebuild-recover — finish an interrupted rebuild commit (under the KB lock) and
 * re-render the registry, digest and INDEX the commit would have rendered.
 * Shared by the sweep, the tick and the rebuild.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KbRoots } from "../shared/index.js";
import {
  recoverRebuild, pendingJournalDomain, rebuildJournalFile, rebuildBadJournalFile, restoreRebuild, rebuildOldValuesFile,
  type RecoverResult, type RestoreResult, type CommitHooks,
} from "./rebuild-commit.js";
import { readLedger, foldRegistry } from "./ledger.js";
import { renderRegistry } from "./registry.js";
import { renderDomainDigest, renderDomainIndex } from "./domains.js";

/** Finishes a pending journal and re-renders. `n` is the writes finished; `quarantined` is true only if THIS call moved an unreadable journal aside. */
export function recoverAndRender(roots: KbRoots, notify?: (msg: string) => void, hooks: Pick<CommitHooks, "rename"> = {}): RecoverResult {
  const domain = pendingJournalDomain(roots);
  const r = recoverRebuild(roots, { notify, rename: hooks.rename });
  if (r.n > 0) {
    notify?.(`recovered an interrupted rebuild (${r.n} write(s) finished)`);
    renderRegistry(roots, foldRegistry(readLedger(roots)));
    if (domain) { renderDomainDigest(roots, domain); renderDomainIndex(roots, domain); }
  }
  return r;
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

/** Consecutive failed runs before the journal may be quarantined. */
export const RECOVER_MAX_FAILURES = 3;
/**
 * Quarantine rule (the simpler of the two options considered): a journal that fails recovery is only moved aside once it has
 * failed RECOVER_MAX_FAILURES runs AND is at least this old (file mtime), so three quick failures (full disk, a lock, a sync in
 * progress) cannot quarantine a journal that would recover minutes later. An UNREADABLE journal (parse error) is deterministic
 * and is quarantined at once by recoverRebuild. If the failure counter cannot be written the count is treated as max and the
 * age gate is skipped (see tryRecoverAndRender).
 */
export const RECOVER_MIN_JOURNAL_AGE_MS = 10 * 60_000;
const failuresFile = (r: KbRoots) => join(r.denLocal, ".rebuild-recover-failures");
const readFailures = (r: KbRoots): number => { try { return Number(readFileSync(failuresFile(r), "utf-8")) || 0; } catch { return 0; } };

export interface RecoverOutcome {
  /** Writes finished (0 when there was nothing to do or recovery failed). */
  n: number;
  /** Set when a journal is present and recovery failed this run: the caller must SKIP the run (the tree may be half-committed). */
  failed?: string;
  /** True only when this run actually moved the journal to .rebuild-journal.bad (and it is verified gone). */
  quarantined?: boolean;
}
export interface TryRecoverHooks {
  /** Test seams. */
  rename?: (from: string, to: string) => void;
  writeCounter?: (path: string, text: string) => void;
  now?: () => number;
}

/** The note shown while an operator has not yet dealt with a quarantined journal; undefined when there is none. */
export function badJournalNote(roots: KbRoots): string | undefined {
  return existsSync(rebuildBadJournalFile(roots))
    ? `a quarantined rebuild journal is present (${rebuildBadJournalFile(roots)}): the last rebuild may be half-applied. Inspect it, run \`rebuild --restore <ts> --yes\` if needed, then delete the file`
    : undefined;
}

/** While a journal is present and recovery keeps failing: the paused state `kb status` shows (undefined when not paused). */
export function recoveryPausedNote(roots: KbRoots): string | undefined {
  if (!existsSync(rebuildJournalFile(roots))) return undefined;
  const n = readFailures(roots);
  return n > 0
    ? `sweep and tick are PAUSED: recovering the unfinished rebuild journal has failed ${n} run(s) in a row (it is quarantined only after ${RECOVER_MAX_FAILURES} failures and ${RECOVER_MIN_JOURNAL_AGE_MS / 60_000} minutes). Fix the cause (disk, permissions) or inspect ${rebuildJournalFile(roots)}`
    : undefined;
}

/**
 * recoverAndRender for the sweep and the tick; it never throws. While a journal is present and recovery FAILS the
 * result says so (`failed`) and the caller must skip the run instead of placing entries into a half-committed tree.
 * One run = one attempt (the tick returns without calling the sweep when recovery failed, so it cannot count twice).
 * Quarantine (journal moved to .rebuild-journal.bad) needs RECOVER_MAX_FAILURES failed runs AND a journal at least
 * RECOVER_MIN_JOURNAL_AGE_MS old, and is only reported once the journal is verified gone; if the move fails the
 * counter is kept and the result is `failed` with "quarantine failed". If the failure counter cannot be WRITTEN the
 * count is treated as max and a quarantine is attempted at once (never loop forever on a journal we cannot count).
 * After a successful quarantine later runs proceed and report badJournalNote until an operator removes the file.
 */
export function tryRecoverAndRender(roots: KbRoots, notify?: (msg: string) => void, hooks: TryRecoverHooks = {}): RecoverOutcome {
  if (!existsSync(rebuildJournalFile(roots))) return { n: 0 };
  const now = hooks.now ?? Date.now;
  try {
    const r = recoverAndRender(roots, notify, { rename: hooks.rename });
    rmSync(failuresFile(roots), { force: true });
    // recoverRebuild reports an unreadable journal it moved aside: that is a stop for this run, not a success
    if (r.quarantined) return { n: 0, failed: "the rebuild journal was unreadable and has been quarantined", quarantined: true };
    return { n: r.n };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    let count = readFailures(roots) + 1;
    let counterBroken = false;
    try { (hooks.writeCounter ?? writeFileSync)(failuresFile(roots), String(count)); } catch { counterBroken = true; }
    if (counterBroken) count = Math.max(count, RECOVER_MAX_FAILURES);
    let ageMs = 0;
    try { ageMs = now() - statSync(rebuildJournalFile(roots)).mtimeMs; } catch { /* gone */ }
    const mayQuarantine = counterBroken || (count >= RECOVER_MAX_FAILURES && ageMs >= RECOVER_MIN_JOURNAL_AGE_MS);
    if (!mayQuarantine) {
      const shown = Math.min(count, RECOVER_MAX_FAILURES);
      const wait = count >= RECOVER_MAX_FAILURES ? `; quarantine waits until the journal is ${RECOVER_MIN_JOURNAL_AGE_MS / 60_000} minutes old` : "";
      notify?.(`rebuild recovery failed (${shown}/${RECOVER_MAX_FAILURES}): ${why}; this run is skipped (the tree may be half-committed), will retry next run${wait}`);
      return { n: 0, failed: `rebuild recovery failed (${shown}/${RECOVER_MAX_FAILURES}): ${why}` };
    }
    let qerr = "";
    try { (hooks.rename ?? renameSync)(rebuildJournalFile(roots), rebuildBadJournalFile(roots)); } catch (e) { qerr = e instanceof Error ? e.message : String(e); }
    if (!existsSync(rebuildJournalFile(roots))) {
      rmSync(failuresFile(roots), { force: true });
      notify?.(`rebuild recovery failed ${count} runs in a row (${why}); the journal was moved to ${rebuildBadJournalFile(roots)}. This run is skipped; later runs continue, but check the KB with \`status\` (restore with \`rebuild --restore\` if needed)`);
      return { n: 0, failed: `rebuild recovery failed ${count} runs in a row; journal quarantined`, quarantined: true };
    }
    // still there: the counter file stays, the sweep stays paused
    notify?.(`rebuild recovery failed (${why}) and the journal could not be quarantined${qerr ? ` (${qerr})` : ""}; the sweep stays paused until it is fixed or removed by an operator`);
    return { n: 0, failed: `rebuild recovery failed (${why}); quarantine failed${qerr ? `: ${qerr}` : ""}` };
  }
}
