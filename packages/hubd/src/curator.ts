/**
 * The hub curator: the KB sweep (packages/kb runSweepTick) run inside hubd on the hub's contributions lane.
 *
 *   lane      <dataDir>/kb/ops/contributions/<wolf>/*.md (what link contributions land in), receipts to <dataDir>/kb/ops/receipts
 *             (link-contributions relays them back to the wolf), handled files to _processed/.
 *   writes    through a SweepWriter (kb/librarian/sweep-writer.ts): entries, _registry.md, _digest.json and INDEX.md go through
 *             `commitKb` (actor system: validation, the writer queue, the journal, entry_written, kb.changed); the other KB
 *             files (ledger events, _sections.json, entry versions, Delivered-list rewrites) are written inside `kb.exclusive`,
 *             the same writer queue. The queue is held only around each write, never during an engine or embedding call.
 *   events    sweep_started / sweep_item / sweep_finished on the hub event bus; started and finished are always paired.
 *   lease     `<inboxRoot>/.sweep-lease` (kb/librarian/curator-lease.ts): the hub holds it while the curator is on; a fresh wolf
 *             lease refuses start and skips a tick; wolf-side sweeps skip while the hub lease is fresh.
 *   KNOWN WINDOW (not closed here, same as the wolf-side sweep): sweep.ts commits the entry (commitKb logs its entry_written) and
 *             only THEN appends the ledger batch that marks the contribution hash as seen. A crash or a failing append between
 *             the two leaves a live entry with the contribution still unseen, so the next tick routes it again and can create a
 *             second entry. Wiring cannot close it (entries carry no contribution hash to check); see the ticket follow-up.
 *   not covered  reorg / rebuild / retire / split-fat and tryRecoverAndRender are not under the sweep lease and write the KB
 *             directly, bypassing commitKb: do not run them against a live hub KB.
 *   flag      off unless `enabled`. No decision logic lives here: sweep.ts decides, this file only writes and reports.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { loadModelTable, type Engine } from "@wolfpack/engine";
import {
  acquireLease,
  appendLedger,
  createEmbedder,
  createLibrarianEngine,
  defaultSweepWriter,
  resolveEmbedConfig,
  freshLeaseIn,
  renderDomainDigest,
  renderDomainIndex,
  renderEntry,
  renderRegistry,
  runSweepTick,
  snapshotIfChanged,
  syncDelivered,
  wolfLeaseDirs,
  writeSections,
  type CachedEmbedder,
  type LeaseHandle,
  type SweepEvent,
  type SweepWriter,
} from "@wolfpack/kb/librarian";
import { contentHash, entriesDir, type KbEvent, type KbRoots } from "@wolfpack/kb/shared";
import type { Actor, KbChange, KbCommitRequest, KbCommitResponse } from "@wolfpack/protocol";
import type { HubEventDraft } from "./events.js";
import { CONTRIBUTIONS_LANE } from "./layout.js";

export const SYSTEM_ACTOR: Actor = { id: "system", kind: "system" };
export const DEFAULT_CURATOR_POLL_MS = 60_000;
const DEFAULT_CLOSE_WAIT_MS = 15_000;

export interface CuratorOptions {
  /** Switch (default false = off: no lease, no timer, `runCuratorOnce` does nothing). Env HUBD_CURATOR in the hubd CLI. */
  enabled?: boolean;
  /** Tick timer, ms (default 60000; 0 = no timer, tests call runCuratorOnce). */
  pollMs?: number;
  /** Path of a models.json (the resolved model table) for the engine. Env HUBD_CURATOR_MODELS. Default: loadModelTable()'s own lookup. */
  modelsFile?: string;
  /** Test seam: the engine (default: createLibrarianEngine on the model table). */
  createEngine?: () => Engine;
  /** Embedding service URL / model for placement (env HUBD_EMBED_URL / HUBD_EMBED_MODEL in the CLI). Default: WOLFPACK_EMBED_URL / _MODEL or nomic-embed-text on 127.0.0.1:11434. NOTE: the sweep adds nomic's task prefixes keyed on the process-wide model name, so a non-nomic model needs WOLFPACK_EMBED_MODEL set as well. */
  embedUrl?: string;
  embedModel?: string;
  /** Test seam: the embedder (default: the KB's cached embedder; its URL/model come from embedUrl / embedModel). */
  getEmbedder?: () => CachedEmbedder;
  /** Test seam: run budget for the one item (see SweepTickOptions.budgetMs). */
  budgetMs?: number;
  /** How long close() waits for a tick in flight, ms (default 15000, under the unit's TimeoutStopSec=20). A tick still running after that stops writing (every writer call checks the closing flag) and the lease is released when it ends. */
  closeWaitMs?: number;
  /** @internal TEST-ONLY: runs inside an entry write, after the file was read for the compare-and-set and before the commit (a racing writer). */
  afterEntryRead?: (entryId: string) => void;
  /** @internal TEST-ONLY: wraps the tick's writer (failure injection). */
  wrapWriter?: (w: SweepWriter) => SweepWriter;
  /** @internal TEST-ONLY: called at the end of start() (simulates a later startup step failing). */
  afterStart?: () => void;
}

export interface CuratorRun {
  outcome: "idle" | "backoff" | "ran" | "skipped";
  processed: number;
  created: number;
  merged: number;
  rejected: number;
  parked: number;
  remaining: number;
  /** Why it was skipped / paused, or the first item error of the tick. */
  error?: string;
}

export interface Curator {
  /** Start the timer (a no-op with pollMs 0 or when off). */
  start(): void;
  /** One tick now. Undefined when off, closing, or a tick is already running. */
  runOnce(): Promise<CuratorRun | undefined>;
  /** Stop the timer, wait (bounded) for a tick in flight, release the lease. */
  close(): Promise<void>;
}

export interface CuratorDeps {
  dataDir: string;
  roots: KbRoots;
  /** The hub's contributions lane root (must be `<opsRoot>/contributions`; the lease lives in it). */
  inboxRoot: string;
  /** The receipts root the hub relays from (must be `<opsRoot>/receipts`: the sweep writes receipts there). */
  receiptsRoot: string;
  commit: (actor: Actor, req: KbCommitRequest) => Promise<KbCommitResponse>;
  exclusive: <T>(fn: () => T) => Promise<T | undefined>;
  emit: (draft: HubEventDraft) => void;
  options?: CuratorOptions;
}

const err1 = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

/**
 * The hubd SweepWriter. Every method refuses once `closing()` is true (the tick then fails its item, which stays queued).
 * `pending` counts, per entry id, the commitKb commits that already logged an entry_written: appendLedger drops one sweep-made
 * entry_written per pending commit (and only those), so each commit is logged exactly once. A commit that changed nothing, and a
 * patchEntry (the sweep adds no entry_written for it), never add to it.
 */
export function createHubSweepWriter(d: Pick<CuratorDeps, "commit" | "exclusive"> & { closing?: () => boolean }, hooks: { afterEntryRead?: (id: string) => void } = {}): SweepWriter & { pending: Map<string, number> } {
  const pending = new Map<string, number>();
  /** Run `fn` in the writer queue; the hub answers undefined only when it is shutting down (then the item fails and stays queued). */
  const excl = async <T>(fn: () => T): Promise<T> => {
    const r = await d.exclusive(() => ({ v: fn() }));
    if (r === undefined) throw new Error("the hub is shutting down");
    return r.v;
  };
  const fileOf = (roots: KbRoots, domain: string, path: string) => join(roots.kbBase, "domains", domain, path);
  const change = (roots: KbRoots, domain: string, path: string, content: string): KbChange | null => {
    const file = fileOf(roots, domain, path);
    const prev = existsSync(file) ? readFileSync(file, "utf-8") : null;
    if (prev === content) return null;
    return prev === null
      ? { op: "create", domain, path, content, contentHash: contentHash(content), prevHash: null }
      : { op: "update", domain, path, content, contentHash: contentHash(content), prevHash: contentHash(prev) };
  };
  /** True when something was committed. */
  const commitFiles = async (roots: KbRoots, files: Array<{ domain: string; path: string; content: string }>, afterRead?: () => void): Promise<boolean> => {
    const changes = files.map((f) => change(roots, f.domain, f.path, f.content)).filter((c): c is KbChange => c !== null);
    afterRead?.();
    if (changes.length === 0) return false;
    await d.commit(SYSTEM_ACTOR, { changes });
    return true;
  };
  /** Render with a sink, then commit what was rendered. */
  const collect = (render: (sink: (file: string, content: string) => void) => void) => {
    const out: Array<{ domain: string; path: string; content: string }> = [];
    render((file, content) => out.push({ domain: basename(dirname(file)), path: basename(file), content }));
    return out;
  };
  const stripStamp = (s: string) => s.replace(/^_Updated: .*_$/m, "");

  const w: SweepWriter = {
    async commitEntry(roots, entry) {
      const path = `entries/${entry.id}.md`;
      const next = renderEntry(entry);
      const file = fileOf(roots, entry.domain, path);
      if (existsSync(file)) {
        const prev = readFileSync(file, "utf-8");
        if (prev !== next) await excl(() => snapshotIfChanged(roots, entry.domain, entry.id, prev, next)); // keep what is overwritten (versions/)
      }
      if (await commitFiles(roots, [{ domain: entry.domain, path, content: next }], () => hooks.afterEntryRead?.(entry.id))) pending.set(entry.id, (pending.get(entry.id) ?? 0) + 1);
    },
    async patchEntry(roots, domain, id, content) {
      await commitFiles(roots, [{ domain, path: `entries/${id}.md`, content }]);
    },
    async appendLedger(roots, events) {
      // commitKb already wrote the entry_written of every entry committed above; a second one would double-count it.
      const left = new Map(pending);
      const rest = events.filter((e: KbEvent) => {
        const id = (e as { entryId?: string }).entryId ?? "";
        if ((e as { t?: string }).t !== "entry_written" || !(left.get(id) ?? 0)) return true;
        left.set(id, left.get(id)! - 1);
        return false;
      });
      if (rest.length > 0) await excl(() => appendLedger(roots, rest));
      for (const [id, n] of left) n > 0 ? pending.set(id, n) : pending.delete(id); // consumed only once the append went through
    },
    async syncDelivered(roots, domain, key) {
      // Rewrites entries in place (holder + members) and may snapshot versions: inside the writer queue. The revision scan records them.
      return excl(() => syncDelivered(roots, domain, key));
    },
    async writeSections(roots, sections) {
      await excl(() => writeSections(roots, sections));
    },
    async renderDomain(roots, domain) {
      await commitFiles(roots, collect((sink) => {
        renderDomainIndex(roots, domain, sink);
        renderDomainDigest(roots, domain, sink);
      }));
    },
    async renderRegistry(roots, reg) {
      try {
        const files = collect((sink) => void renderRegistry(roots, reg, [], sink)).filter((f) => {
          const file = fileOf(roots, f.domain, f.path);
          return !existsSync(file) || stripStamp(readFileSync(file, "utf-8")) !== stripStamp(f.content); // only the timestamp moved: no commit
        });
        await commitFiles(roots, files);
      } catch (e) {
        // A derived projection: the next tick re-renders it. Never fails the item that is already committed.
        console.warn(`hubd curator: _registry.md not updated (${err1(e)})`);
      }
    },
    writeReceipt: defaultSweepWriter.writeReceipt,
    markProcessed: defaultSweepWriter.markProcessed,
    quarantine: defaultSweepWriter.quarantine,
    // The hub's KB is not a git repo of its own (and `git -C` would climb into whatever repo holds the data dir): never commit.
    gitCommit: () => undefined,
  };
  // Closing gate: nothing is written once the curator is closing, not even by the default (plain disk) methods.
  const gated = Object.fromEntries(
    Object.entries(w).map(([k, fn]) => [k, (...args: unknown[]) => {
      if (d.closing?.()) throw new Error("the hub is shutting down");
      return (fn as (...a: unknown[]) => unknown)(...args);
    }])
  ) as unknown as SweepWriter;
  return Object.assign(gated, { pending });
}

export function createCurator(deps: CuratorDeps): Curator {
  const o = deps.options ?? {};
  const enabled = o.enabled === true;
  const pollMs = o.pollMs ?? DEFAULT_CURATOR_POLL_MS;
  let lease: LeaseHandle | undefined;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<CuratorRun | undefined> | undefined;
  let closing = false;
  let warnedWolf = false;

  if (enabled) {
    // Startup preconditions: the lane and receipts must be the hub's own (the sweep reads <opsRoot>/contributions and writes
    // <opsRoot>/receipts), and no wolf-side sweep may hold the KB.
    const want = join(deps.roots.opsRoot, CONTRIBUTIONS_LANE);
    if (deps.inboxRoot !== want) throw new Error(`HUBD_CURATOR needs the hub's own contributions lane (${want}); HUBD_INBOX_ROOT is ${deps.inboxRoot}`);
    const wantReceipts = join(deps.roots.opsRoot, "receipts");
    if (deps.receiptsRoot !== wantReceipts) throw new Error(`HUBD_CURATOR needs the hub's own receipts lane (${wantReceipts}); HUBD_RECEIPTS_ROOT is ${deps.receiptsRoot}`);
    const wolf = freshLeaseIn(wolfLeaseDirs(deps.roots), "wolf");
    if (wolf) throw new Error(`HUBD_CURATOR: a wolf-side sweep holds the sweep lease (pid ${wolf.pid} on ${wolf.host}); stop it (the librarian's sweep timer / kb sweep) before turning the hub curator on`);
    const got = acquireLease([deps.inboxRoot], "hub");
    if (!got) throw new Error("HUBD_CURATOR: could not take the sweep lease (another sweeper holds it)");
    lease = got;
  }

  const runTick = async (): Promise<CuratorRun> => {
    const t0 = Date.now();
    const tally = { processed: 0, created: 0, merged: 0, rejected: 0, parked: 0, remaining: 0 };
    let started = false;
    let finished = false;
    let pending = 0;
    const emit = (d: HubEventDraft) => {
      try {
        deps.emit(d);
      } catch {
        /* a bad subscriber never breaks the sweep */
      }
    };
    const finish = (error?: string) => {
      if (!started || finished) return;
      finished = true;
      emit({ type: "sweep_finished", ...tally, durationMs: Date.now() - t0, ...(error ? { error } : {}) });
    };
    const onEvent = (e: SweepEvent) => {
      if (finished) return;
      if (e.type === "started") {
        if (started) return;
        started = true;
        pending = e.pending;
        emit({ type: "sweep_started", pending: e.pending });
      } else {
        if (!started) return;
        tally.processed++;
        if (e.outcome === "create") tally.created++;
        else if (e.outcome === "merge") tally.merged++;
        else if (e.outcome === "reject") tally.rejected++;
        else tally.parked++;
        emit({ type: "sweep_item", from: e.from, denTopicId: e.denTopicId, outcome: e.outcome, ...(e.entryId ? { entryId: e.entryId } : {}) });
      }
    };
    const base = createHubSweepWriter({ ...deps, closing: () => closing }, { afterEntryRead: o.afterEntryRead });
    const writer = o.wrapWriter ? o.wrapWriter(base) : base;
    try {
      const tick = await runSweepTick({
        roots: deps.roots,
        lane: CONTRIBUTIONS_LANE,
        writer,
        createEngine: o.createEngine ?? (() => createLibrarianEngine(loadModelTable(o.modelsFile ? { file: o.modelsFile } : {}).table)),
        leaseOwner: "none", // the hub lease is held by this curator for its whole life
        ...(o.getEmbedder ? { getEmbedder: o.getEmbedder } : o.embedUrl || o.embedModel ? { getEmbedder: () => createEmbedder(deps.roots, { baseUrl: o.embedUrl ?? resolveEmbedConfig().baseUrl, model: o.embedModel ?? resolveEmbedConfig().model }) } : {}),
        budgetMs: o.budgetMs,
        notePoster: null, // work link-back notes stay queued; the hub owns the work ledger and has no Work API to post to
        notify: (m) => console.log(`[curator] ${m}`),
        alert: (m) => console.warn(`[curator] ${m}`),
        onEvent,
      });
      const r = tick.sweep;
      const error = r.errors > 0 ? (r.failures[0]?.reason ?? r.paused ?? "an item failed") : undefined;
      tally.remaining = r.remaining; // parked / processed are the per-item counts the events already carried
      finish(error);
      return { outcome: tick.outcome, processed: r.processed, created: r.created, merged: r.merged, rejected: r.rejected, parked: r.parked.length, remaining: r.remaining, ...((error ?? r.paused) ? { error: error ?? r.paused } : {}) };
    } catch (e) {
      const msg = err1(e);
      console.error("[curator] sweep failed:", msg);
      tally.remaining = Math.max(0, pending - tally.processed);
      finish(msg);
      return { outcome: "ran", ...tally, error: msg };
    }
  };

  const runOnce = (): Promise<CuratorRun | undefined> => {
    if (!enabled || closing || inflight) return Promise.resolve(undefined);
    if (freshLeaseIn(wolfLeaseDirs(deps.roots), "wolf")) {
      if (!warnedWolf) console.warn("[curator] skipped: a wolf-side sweep holds the sweep lease");
      warnedWolf = true;
      return Promise.resolve({ outcome: "skipped", processed: 0, created: 0, merged: 0, rejected: 0, parked: 0, remaining: 0, error: "a wolf-side sweep holds the sweep lease" });
    }
    warnedWolf = false;
    const p = runTick().finally(() => {
      inflight = undefined;
    });
    inflight = p;
    return p;
  };

  return {
    start() {
      if (!enabled || pollMs <= 0 || timer) return;
      timer = setInterval(() => void runOnce().catch((e) => console.error("[curator] tick failed:", err1(e))), pollMs);
      timer.unref();
      o.afterStart?.();
    },
    runOnce,
    async close() {
      closing = true; // from here every writer call of a tick in flight is refused
      if (timer) clearInterval(timer);
      timer = undefined;
      const p = inflight;
      if (p) {
        let to: NodeJS.Timeout | undefined;
        await Promise.race([p.catch(() => undefined), new Promise<void>((r) => (to = setTimeout(r, o.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS)))]);
        if (to) clearTimeout(to);
      }
      const l = lease;
      lease = undefined;
      if (!l) return;
      // The lease stays while a tick is still running (it keeps heartbeating); it goes when that tick ends.
      if (inflight) void inflight.then(() => l.release(), () => l.release());
      else l.release();
    },
  };
}
