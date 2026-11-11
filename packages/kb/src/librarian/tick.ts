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
import { DomainsFileError } from "../shared/domain-registry.js";
import { readDeclaredDomains } from "./domains.js";
import { rebuildJournalFile } from "./rebuild-commit.js";
import { tryRecoverAndRender, badJournalNote } from "./rebuild-recover.js";
import type { KbRoots, KbEvent } from "../shared/index.js";
import type { SweepWriter } from "./sweep-writer.js";
import { sweep, emptyResult, type SweepEvent, type SweepResult } from "./sweep.js";
import { reorg, type ReorgResult } from "./reorg.js";
import { countPending } from "./intake.js";
import { readLedgerAsync, foldRegistry } from "./ledger.js";
import { createEmbedder, buildEntryVectors, currentEntryHashes, type CachedEmbedder } from "./embed.js";
import { backoffRemainingMs, classifyError, noteInfraFailure, type Alert } from "./backoff.js";
import { BudgetExceeded, SweepStuck } from "./park.js";
import { noteDrainProgress, flushDrain } from "./drain.js";
import { flushWorkLinks, hasPendingWorkLinks, httpNotePoster, type NotePoster } from "./work-links.js";
import { withKbLock, KbLockBusy } from "./lock.js";
import { createTimings, TICK_STEPS } from "./timings.js";
import { acquireLease, freshLeaseIn, wolfLeaseDirs } from "./curator-lease.js";

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
  /** Test seam: the outer budget for the whole sweep (default SWEEP.runBudgetMs + 4 embed timeouts). */
  outerBudgetMs?: number;
  /** Test seam: how long an aborted sweep may keep running before a loud warning (default 60 s). */
  abortGraceMs?: number;
  /** Test seam: the warning repeats this often while the aborted sweep still runs (default 5 min). */
  abortRepeatMs?: number;
  /** Test seam: after the grace, how much longer the tick waits for the aborted sweep before it stops waiting and throws SweepStuck (default 5 min). */
  abortCapMs?: number;
  /** Called with true when the outer budget aborts the sweep and with false when that sweep finally settles (even after the tick gave up waiting). */
  onSweepStuck?: (stuck: boolean) => void;
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
  /** The lane under the ops root holding the contributions (default `inbox`; hubd's is `contributions`). */
  lane?: string;
  /**
   * Who holds the sweep lease for this tick (curator-lease.ts). "wolf" (default): this tick takes a wolf lease on both lanes and
   * skips while a hub lease is fresh. "none": the caller manages the lease (the hub curator holds the hub lease).
   */
  leaseOwner?: "wolf" | "none";
  /** Where the sweep's writes go (default: straight to disk; see sweep-writer.ts). Not used by the post-sweep reorg. */
  writer?: SweepWriter;
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
  // A wolf-side sweep (harness timer, kb CLI) never runs with the hub's curator on the same KB: it skips the tick (like an idle
  // one) while a fresh hub lease exists, and holds a wolf lease while it runs. The hub curator passes leaseOwner "none" and
  // manages its own lease. NOT covered by the lease: reorg, rebuild, retire, split-fat and tryRecoverAndRender; they take only
  // the den-local KB lock and write the KB directly (they bypass hubd's commitKb), so never run them against a live hub KB.
  if ((opts.leaseOwner ?? "wolf") === "wolf") {
    const dirs = wolfLeaseDirs(opts.roots);
    const key = opts.roots.opsRoot;
    const skip = (why: string) => {
      if (lastSkip.get(key) !== why) opts.notify?.(`sweep: skipped, ${why}`); // tell once per change, not every tick
      lastSkip.set(key, why);
      return { outcome: "idle" as const, sweep: emptyResult() };
    };
    if (freshLeaseIn(dirs, "hub")) return skip("the hub curator holds the sweep lease");
    const lease = acquireLease(dirs, "wolf");
    if (!lease) return skip("another sweeper holds the sweep lease");
    lastSkip.delete(key);
    try {
      return await runSweepTickLeased(opts);
    } finally {
      lease.release();
    }
  }
  return runSweepTickLeased(opts);
}

/** Last skip reason per ops root (so the wolf-side skip notice is sent when the state changes, not every tick). */
const lastSkip = new Map<string, string>();

async function runSweepTickLeased(opts: SweepTickOptions): Promise<SweepTickResult> {
  const result = await runTick(opts);
  const bad = badJournalNote(opts.roots);
  if (bad && !result.sweep.journalBad) result.sweep = { ...result.sweep, journalBad: bad };
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
  // While a journal is present and recovery fails the run is SKIPPED (paused): placing entries into a half-committed
  // tree would make it worse. The tick is one attempt; the sweep is not called, so it cannot count a second one.
  if (existsSync(rebuildJournalFile(roots))) {
    try {
      const failed = await withKbLock(roots, async () => tryRecoverAndRender(roots, opts.notify).failed);
      // outcome "backoff" is used on purpose WITHOUT touching the backoff state (backoff.json): it is the existing "did no work, retry next
      // run" outcome; setting real backoff state would delay the retry by minutes and raise outage alerts for a local file problem.
      if (failed) return { outcome: "backoff", sweep: { ...emptyResult(), remaining: countPending(roots.opsRoot, { lane: opts.lane }).total, paused: failed, journalBad: badJournalNote(roots) } };
    } catch (err) {
      if (!(err instanceof KbLockBusy)) throw err;
    }
  }

  const waitMs = backoffRemainingMs(roots);
  if (waitMs > 0) {
    return { outcome: "backoff", sweep: { ...emptyResult(), paused: `backing off, ${Math.ceil(waitMs / 1000)}s left` } };
  }
  if (countPending(roots.opsRoot, { lane: opts.lane }).total === 0) {
    await flushDrain(roots, opts.alert);
    return { outcome: "idle", sweep: emptyResult() };
  }

  // Fail closed: an unusable WOLFPACK_DOMAINS_FILE skips this tick (logged, retried next run), it never opens the gate or crashes the loop.
  try {
    readDeclaredDomains(roots);
  } catch (err) {
    if (!(err instanceof DomainsFileError)) throw err;
    opts.notify?.(`sweep: skipped, ${err.message}`);
    return { outcome: "backoff", sweep: { ...emptyResult(), remaining: countPending(roots.opsRoot, { lane: opts.lane }).total, paused: err.message } };
  }

  try {
    const result = await tick(opts);
    // Tally this tick; once the inbox is really empty, send the one summary.
    noteDrainProgress(roots, result.sweep);
    if (!result.sweep.paused && countPending(roots.opsRoot, { lane: opts.lane }).total === 0) await flushDrain(roots, opts.alert);
    return result;
  } catch (err) {
    if (classifyError(err) !== "infra") throw err;
    const state = await noteInfraFailure(roots, err, opts.alert);
    opts.notify?.(`sweep: infrastructure error, backing off (${state.consecutive} in a row): ${err instanceof Error ? err.message : err}`);
    return { outcome: "backoff", sweep: { ...emptyResult(), paused: state.reason } };
  }
}

const ABORT_GRACE_MS = 60_000;
const ABORT_REPEAT_MS = 5 * 60_000;
const ABORT_CAP_MS = 5 * 60_000;

interface AbortTiming { graceMs: number; repeatMs: number; capMs: number; warn: (m: string) => void; onStuck?: (stuck: boolean) => void }

/**
 * Run `run` under an outer budget. On expiry abort it and wait for it to really settle: warn after the grace and again every
 * `repeatMs` until it ends. If it is still alive `capMs` after the grace, stop waiting and reject with SweepStuck (the KB lock
 * stays the overlap guard). Otherwise reject with BudgetExceeded once it has ended.
 */
async function sweepWithin<T>(ms: number, t: AbortTiming, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const real = run(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((r) => { timer = setTimeout(() => r("expired"), ms); });
  try {
    const first = await Promise.race([real, expired]);
    if (first !== "expired") return first;
  } finally {
    clearTimeout(timer);
  }
  const err = new BudgetExceeded(ms, "sweep");
  controller.abort(err);
  t.onStuck?.(true);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let alertTimer: ReturnType<typeof setInterval> | undefined;
  const warnStill = () => t.warn(`sweep: still running after its ${Math.round(ms / 1000)}s budget was aborted; no new sweep starts until it ends`);
  graceTimer = setTimeout(() => {
    warnStill();
    alertTimer = setInterval(warnStill, t.repeatMs);
    alertTimer.unref();
  }, t.graceMs);
  graceTimer.unref();
  // Observe the real sweep to the end: it clears the stuck marker and the alerts whenever it settles, even after the tick gave up waiting.
  const ended = real.then(
    () => undefined,
    (e) => {
      if (e !== err) t.warn(`sweep: the aborted sweep ended with an error: ${e instanceof Error ? e.message : String(e)}`); // the abort reason itself is expected
    },
  ).finally(() => {
    clearTimeout(graceTimer);
    clearInterval(alertTimer);
    t.onStuck?.(false);
  });
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<"cap">((r) => { capTimer = setTimeout(() => r("cap"), t.graceMs + t.capMs); capTimer.unref(); });
  try {
    if ((await Promise.race([ended.then(() => "ended" as const), capped])) === "cap") throw new SweepStuck(ms, Math.round((t.graceMs + t.capMs) / 1000));
  } finally {
    clearTimeout(capTimer);
  }
  throw err;
}

async function tick(opts: SweepTickOptions): Promise<SweepTickResult> {
  const { roots, notify } = opts;
  const engine = opts.createEngine();

  // Built on first use: a duplicate-only inbox never reads the vector cache.
  let embedder: CachedEmbedder | undefined;
  const getEmbedder = () => (embedder ??= opts.getEmbedder?.() ?? createEmbedder(roots));
  let liveEntries = 0;
  const timings = createTimings();
  // The ledger is parsed once per tick; the sweep's duplicate check and the vectors share it (nothing appends before both ran).
  let ledgerMemo: Promise<KbEvent[]> | undefined;
  const readLog = () => (ledgerMemo ??= readLedgerAsync(roots));
  const loadEntryVectors = async () => {
    const reg = foldRegistry(await readLog());
    const vectors = await buildEntryVectors(roots, reg, getEmbedder(), undefined, timings);
    liveEntries = vectors.length;
    return vectors;
  };

  // Past the run budget plus slack the sweep is aborted (it stops at the next item boundary) and the tick waits for it to end.
  const swept = await sweepWithin(opts.outerBudgetMs ?? SWEEP.runBudgetMs + SWEEP.embedTimeoutMs * 4, { graceMs: opts.abortGraceMs ?? ABORT_GRACE_MS, repeatMs: opts.abortRepeatMs ?? ABORT_REPEAT_MS, capMs: opts.abortCapMs ?? ABORT_CAP_MS, warn: (m) => void opts.alert?.(m), onStuck: opts.onSweepStuck }, (signal) =>
    sweep({ engine, roots, loadEntryVectors, getEmbedder, notify, alert: opts.alert, budgetMs: opts.budgetMs, onEvent: opts.onEvent, lane: opts.lane, writer: opts.writer, timings, readLog, signal }),
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
      const live = embedder;
      const dropped = timings.time("compact", () => live.compact(currentEntryHashes(roots)));
      if (dropped > 0) notify?.(`Vector cache compacted: dropped ${dropped} stale vector(s)`);
    } catch (err) {
      notify?.(`Vector cache compaction failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  notify?.(timings.line(TICK_STEPS));
  return { outcome: "ran", sweep: swept, reorg: reorged };
}
