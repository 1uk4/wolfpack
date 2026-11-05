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
 *   flag      off unless `enabled`. No decision logic lives here: sweep.ts decides, this file only writes and reports.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { loadModelTable, type Engine } from "@wolfpack/engine";
import {
  acquireLease,
  appendLedger,
  createLibrarianEngine,
  defaultSweepWriter,
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
const DEFAULT_CLOSE_WAIT_MS = 5_000;

export interface CuratorOptions {
  /** Switch (default false = off: no lease, no timer, `runCuratorOnce` does nothing). Env HUBD_CURATOR in the hubd CLI. */
  enabled?: boolean;
  /** Tick timer, ms (default 60000; 0 = no timer, tests call runCuratorOnce). */
  pollMs?: number;
  /** Path of a models.json (the resolved model table) for the engine. Env HUBD_CURATOR_MODELS. Default: loadModelTable()'s own lookup. */
  modelsFile?: string;
  /** Test seam: the engine (default: createLibrarianEngine on the model table). */
  createEngine?: () => Engine;
  /** Test seam: the embedder (default: the KB's cached embedder; its URL/model come from WOLFPACK_EMBED_URL / _MODEL, set by the CLI). */
  getEmbedder?: () => CachedEmbedder;
  /** Test seam: run budget for the one item (see SweepTickOptions.budgetMs). */
  budgetMs?: number;
  /** How long close() waits for a tick in flight, ms (default 5000). */
  closeWaitMs?: number;
  /** @internal TEST-ONLY: runs inside an entry write, after the file was read for the compare-and-set and before the commit (a racing writer). */
  afterEntryRead?: (entryId: string) => void;
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

/** The hubd SweepWriter. `committed` collects the entry ids commitKb already logged (entry_written) in this tick. */
export function createHubSweepWriter(d: Pick<CuratorDeps, "commit" | "exclusive">, hooks: { afterEntryRead?: (id: string) => void } = {}): SweepWriter & { committed: Set<string> } {
  const committed = new Set<string>();
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
  const commitFiles = async (roots: KbRoots, files: Array<{ domain: string; path: string; content: string }>, afterRead?: () => void) => {
    const changes = files.map((f) => change(roots, f.domain, f.path, f.content)).filter((c): c is KbChange => c !== null);
    afterRead?.();
    if (changes.length > 0) await d.commit(SYSTEM_ACTOR, { changes });
  };
  /** Render with a sink, then commit what was rendered. */
  const collect = (roots: KbRoots, render: (sink: (file: string, content: string) => void) => void) => {
    const out: Array<{ domain: string; path: string; content: string }> = [];
    render((file, content) => out.push({ domain: basename(dirname(file)), path: basename(file), content }));
    return out;
  };
  const stripStamp = (s: string) => s.replace(/^_Updated: .*_$/m, "");

  return {
    committed,
    async commitEntry(roots, entry) {
      const path = `entries/${entry.id}.md`;
      const next = renderEntry(entry);
      const file = fileOf(roots, entry.domain, path);
      if (existsSync(file)) {
        const prev = readFileSync(file, "utf-8");
        if (prev !== next) await excl(() => snapshotIfChanged(roots, entry.domain, entry.id, prev, next)); // keep what is overwritten (versions/)
      }
      await commitFiles(roots, [{ domain: entry.domain, path, content: next }], () => hooks.afterEntryRead?.(entry.id));
      committed.add(entry.id);
    },
    async patchEntry(roots, domain, id, content) {
      await commitFiles(roots, [{ domain, path: `entries/${id}.md`, content }]);
    },
    async appendLedger(roots, events) {
      // commitKb already wrote the entry_written of every entry committed above; a second one would double-count it.
      const rest = events.filter((e: KbEvent) => !((e as { t?: string }).t === "entry_written" && committed.has((e as { entryId?: string }).entryId ?? "")));
      if (rest.length === 0) return;
      await excl(() => appendLedger(roots, rest));
    },
    async syncDelivered(roots, domain, key) {
      // Rewrites entries in place (holder + members) and may snapshot versions: inside the writer queue. The revision scan records them.
      return excl(() => syncDelivered(roots, domain, key));
    },
    async writeSections(roots, sections) {
      await excl(() => writeSections(roots, sections));
    },
    async renderDomain(roots, domain) {
      await commitFiles(roots, collect(roots, (sink) => {
        renderDomainIndex(roots, domain, sink);
        renderDomainDigest(roots, domain, sink);
      }));
    },
    async renderRegistry(roots, reg) {
      try {
        const files = collect(roots, (sink) => void renderRegistry(roots, reg, [], sink)).filter((f) => {
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
    const writer = createHubSweepWriter(deps, { afterEntryRead: o.afterEntryRead });
    try {
      const tick = await runSweepTick({
        roots: deps.roots,
        lane: CONTRIBUTIONS_LANE,
        writer,
        createEngine: o.createEngine ?? (() => createLibrarianEngine(loadModelTable(o.modelsFile ? { file: o.modelsFile } : {}).table)),
        ...(o.getEmbedder ? { getEmbedder: o.getEmbedder } : {}),
        budgetMs: o.budgetMs,
        notePoster: null, // work link-back notes stay queued; the hub owns the work ledger and has no Work API to post to
        notify: (m) => console.log(`[curator] ${m}`),
        alert: (m) => console.warn(`[curator] ${m}`),
        onEvent,
      });
      const r = tick.sweep;
      const error = r.errors > 0 ? (r.failures[0]?.reason ?? r.paused ?? "an item failed") : undefined;
      tally.remaining = r.remaining;
      tally.parked = r.parked.length;
      finish(error);
      return { outcome: tick.outcome, processed: r.processed, created: r.created, merged: r.merged, rejected: r.rejected, parked: r.parked.length, remaining: r.remaining, ...(error ?? r.paused ? { error: error ?? r.paused } : {}) };
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
    },
    runOnce,
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      const p = inflight;
      if (p) {
        let to: NodeJS.Timeout | undefined;
        await Promise.race([p.catch(() => undefined), new Promise<void>((r) => (to = setTimeout(r, o.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS)))]);
        if (to) clearTimeout(to);
      }
      lease?.release();
      lease = undefined;
    },
  };
}
