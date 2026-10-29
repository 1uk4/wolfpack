/**
 * tick — one sweep tick, shared by both triggers: the harness timer (VPS
 * librarian wolves) and the kb CLI `sweep` (run every minute by launchd on a
 * local Mac). Each tick contributes at most one item.
 *
 * Order: backoff check, idle fast path (a directory listing, no engine, no
 * embedder, no cache or ledger read), sweep one item (duplicates are retired
 * first, before any vector loads), optional post-sweep reorg (off by default)
 * for the domains the item touched, then vector-cache upkeep. One engine and one embedder serve the
 * whole tick.
 */
import { existsSync } from "node:fs";
import { SWEEP, type Engine } from "@wolfpack/engine";
import { rebuildJournalFile } from "./rebuild-commit.js";
import { recoverAndRender } from "./rebuild-recover.js";
import type { KbRoots } from "../shared/index.js";
import { sweep, emptyResult, type SweepEvent, type SweepResult } from "./sweep.js";
import { reorg, type ReorgResult } from "./reorg.js";
import { countPending } from "./intake.js";
import { readLedger, foldRegistry } from "./ledger.js";
import { createEmbedder, buildEntryVectors, currentEntryHashes, type CachedEmbedder } from "./embed.js";
import { backoffRemainingMs, classifyError, noteInfraFailure, type Alert } from "./backoff.js";
import { withBudget } from "./park.js";
import { noteDrainProgress, flushDrain } from "./drain.js";
import { flushWorkLinks, hasPendingWorkLinks, httpNotePoster, type NotePoster } from "./work-links.js";
import { withKbLock, KbLockBusy } from "./lock.js";

export interface SweepTickOptions {
  roots: KbRoots;
  /** Builds the engine; called once per tick, and only when the inbox has work. */
  createEngine: () => Engine;
  /** Progress chatter (log lines, a status line). */
  notify?: (msg: string) => void;
  /** Messages for a human: sweep paused, recovered, an item parked, inbox drained. */
  alert?: Alert;
  /** Test seam: the run budget for the one item (default SWEEP.runBudgetMs). */
  budgetMs?: number;
  /** Where link-back notes for graduated work go (default: the Work API from WORK_ENDPOINT / WORK_TOKEN; none → they stay queued). */
  notePoster?: NotePoster | null;
  /** Structured sweep progress (see SweepContext.onEvent). */
  onEvent?: (event: SweepEvent) => void;
  /** Test seam: replaces the tick's embedder (default: the KB's cached embedder). */
  getEmbedder?: () => CachedEmbedder;
  /**
   * Run the full reorg on the touched domains after a committed item. Default
   * OFF: until incremental repair exists, a sweep only places the new entry
   * (top-down) and never reorganises the tree. WOLFPACK_KB_POST_SWEEP_REORG=1
   * turns it on when this option is unset.
   */
  postSweepReorg?: boolean;
}

function postSweepReorgEnabled(opts: SweepTickOptions): boolean {
  if (opts.postSweepReorg !== undefined) return opts.postSweepReorg;
  return process.env.WOLFPACK_KB_POST_SWEEP_REORG === "1";
}

export interface SweepTickResult {
  /** idle: nothing in the inbox. backoff: skipped, or an outage just began or
   *  continued (sweep.paused says why). ran: the sweep ran. */
  outcome: "idle" | "backoff" | "ran";
  sweep: SweepResult;
  /** Set when the post-sweep reorg ran. */
  reorg?: ReorgResult;
}

/**
 * Run one tick. An infrastructure error anywhere outside the item itself
 * (engine setup, the sweep's own plumbing) enters the shared backoff and comes
 * back as outcome "backoff"; any other error is thrown for the caller to report.
 */
export async function runSweepTick(opts: SweepTickOptions): Promise<SweepTickResult> {
  const result = await runTick(opts);
  await sendWorkLinks(opts);
  return result;
}

/** Post the queued work-item notes (best effort: an unreachable Work API leaves them queued). */
async function sendWorkLinks(opts: SweepTickOptions): Promise<void> {
  try {
    if (!hasPendingWorkLinks(opts.roots)) return;
    const post = opts.notePoster === undefined ? httpNotePoster() : opts.notePoster;
    if (!post) return;
    await withKbLock(opts.roots, () => flushWorkLinks(opts.roots, post, opts.notify));
  } catch (err) {
    if (!(err instanceof KbLockBusy)) opts.notify?.(`work links: ${err instanceof Error ? err.message : err}`);
  }
}

async function runTick(opts: SweepTickOptions): Promise<SweepTickResult> {
  const { roots } = opts;

  // Finish a rebuild that crashed after its journal, before anything else (the check is one stat; idempotent).
  if (existsSync(rebuildJournalFile(roots))) {
    try {
      await withKbLock(roots, async () => { recoverAndRender(roots, opts.notify); });
    } catch (err) {
      if (!(err instanceof KbLockBusy)) throw err;
    }
  }

  const waitMs = backoffRemainingMs(roots);
  if (waitMs > 0) {
    return { outcome: "backoff", sweep: { ...emptyResult(), paused: `backing off, ${Math.ceil(waitMs / 1000)}s left` } };
  }
  if (countPending(roots.opsRoot).total === 0) {
    await flushDrain(roots, opts.alert);
    return { outcome: "idle", sweep: emptyResult() };
  }

  try {
    const result = await tick(opts);
    // Tally this tick; once the inbox is really empty, send the one summary.
    noteDrainProgress(roots, result.sweep);
    if (!result.sweep.paused && countPending(roots.opsRoot).total === 0) await flushDrain(roots, opts.alert);
    return result;
  } catch (err) {
    if (classifyError(err) !== "infra") throw err;
    const state = await noteInfraFailure(roots, err, opts.alert);
    opts.notify?.(`sweep: infrastructure error, backing off (${state.consecutive} in a row): ${err instanceof Error ? err.message : err}`);
    return { outcome: "backoff", sweep: { ...emptyResult(), paused: state.reason } };
  }
}

async function tick(opts: SweepTickOptions): Promise<SweepTickResult> {
  const { roots, notify } = opts;
  const engine = opts.createEngine();

  // Built on first use: a duplicate-only inbox never reads the vector cache.
  let embedder: CachedEmbedder | undefined;
  const getEmbedder = () => (embedder ??= opts.getEmbedder?.() ?? createEmbedder(roots));
  let liveEntries = 0;
  const loadEntryVectors = async () => {
    const vectors = await buildEntryVectors(roots, foldRegistry(readLedger(roots)), getEmbedder());
    liveEntries = vectors.length;
    return vectors;
  };

  // A hung call must never hold the tick: past the run budget plus slack, give
  // up (the KB lock still guards against overlap).
  const swept = await withBudget(SWEEP.runBudgetMs + SWEEP.embedTimeoutMs * 4, () =>
    sweep({ engine, roots, loadEntryVectors, getEmbedder, notify, alert: opts.alert, budgetMs: opts.budgetMs, onEvent: opts.onEvent })
  );

  let reorged: ReorgResult | undefined;
  if (postSweepReorgEnabled(opts) && swept.created + swept.merged > 0) {
    try {
      notify?.("Running post-sweep reorg check...");
      reorged = await reorg({ engine, roots, embedder: getEmbedder(), domains: swept.touchedDomains, notify });
      if (reorged.splits > 0 || reorged.merges > 0 || reorged.crystallized > 0) {
        notify?.(`Reorg: ${reorged.splits} splits, ${reorged.merges} merges, ${reorged.crystallized} crystallized`);
      }
    } catch (err) {
      notify?.(`Post-sweep reorg failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Cache upkeep: after a reorg (entries were rewritten) or once the file
  // holds far more vectors than there are entries.
  if (embedder && (reorged || embedder.shouldCompact(liveEntries))) {
    try {
      const dropped = embedder.compact(currentEntryHashes(roots));
      if (dropped > 0) notify?.(`Vector cache compacted: dropped ${dropped} stale vector(s)`);
    } catch (err) {
      notify?.(`Vector cache compaction failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { outcome: "ran", sweep: swept, reorg: reorged };
}
