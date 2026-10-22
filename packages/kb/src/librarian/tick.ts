/**
 * tick — one sweep tick, shared by both triggers: the harness timer (VPS
 * librarian wolves) and the kb CLI `sweep` (run every minute by launchd on a
 * local Mac). Each tick contributes at most one item.
 *
 * Order: backoff check, idle fast path (a directory listing, no engine, no
 * embedder, no cache or ledger read), sweep one item (duplicates are retired
 * first, before any vector loads), post-sweep reorg for the domains the item
 * touched, then vector-cache upkeep. One engine and one embedder serve the
 * whole tick.
 */
import { SWEEP, type Engine } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";
import { sweep, emptyResult, type SweepResult } from "./sweep.js";
import { reorg, type ReorgResult } from "./reorg.js";
import { countPending } from "./intake.js";
import { readLedger, foldRegistry } from "./ledger.js";
import { createEmbedder, buildEntryVectors, currentEntryHashes, type CachedEmbedder } from "./embed.js";
import { backoffRemainingMs, classifyError, noteInfraFailure, type Alert } from "./backoff.js";
import { withBudget } from "./park.js";

export interface SweepTickOptions {
  roots: KbRoots;
  /** Builds the engine; called once per tick, and only when the inbox has work. */
  createEngine: () => Engine;
  /** Progress chatter (log lines, a status line). */
  notify?: (msg: string) => void;
  /** Messages for a human: sweep paused, recovered, an item parked. */
  alert?: Alert;
  /** Test seam: the run budget for the one item (default SWEEP.runBudgetMs). */
  budgetMs?: number;
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
  const { roots } = opts;

  const waitMs = backoffRemainingMs(roots);
  if (waitMs > 0) {
    return { outcome: "backoff", sweep: { ...emptyResult(), paused: `backing off, ${Math.ceil(waitMs / 1000)}s left` } };
  }
  if (countPending(roots.opsRoot).total === 0) return { outcome: "idle", sweep: emptyResult() };

  try {
    return await tick(opts);
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
  const getEmbedder = () => (embedder ??= createEmbedder(roots));
  let liveEntries = 0;
  const loadEntryVectors = async () => {
    const vectors = await buildEntryVectors(roots, foldRegistry(readLedger(roots)), getEmbedder());
    liveEntries = vectors.length;
    return vectors;
  };

  // A hung call must never hold the tick: past the run budget plus slack, give
  // up (the KB lock still guards against overlap).
  const swept = await withBudget(SWEEP.runBudgetMs + SWEEP.embedTimeoutMs * 4, () =>
    sweep({ engine, roots, loadEntryVectors, getEmbedder, notify, alert: opts.alert, budgetMs: opts.budgetMs })
  );

  let reorged: ReorgResult | undefined;
  if (swept.created + swept.merged > 0) {
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
