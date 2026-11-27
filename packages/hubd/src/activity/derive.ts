/**
 * Hub-derived activity: Work ledger appends and KB commits become `contribution` / `shipped` / `kb-write` events on the activity bus.
 * Only called after a write landed. O(1) per event, never throws into the write path, never carries content (ids and titles only).
 *
 * Who did it: the request's actor (wolf from the token / X-Wolf, `owner` for operator tokens) plus `x-wolfpack-thread-id` and
 * `x-wolfpack-subagent` when the wolf sent them. A request context is kept in AsyncLocalStorage (the write queues chain
 * `.then` from the caller, so the context reaches the post-append hooks). No request context (the hub's own curator, startup scans)
 * or a system actor emits nothing.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sanitizeActivityTitle, type ActivityActor, type ActivityDetail, type ActivityEvent, type ActivityVerb } from "@wolfpack/protocol";
import type { ActivityBus } from "./bus.js";
import type { PresenceStore } from "./presence.js";
import type { ActivityStatsStore } from "./stats.js";

export const THREAD_HEADER = "x-wolfpack-thread-id";
export const SUBAGENT_HEADER = "x-wolfpack-subagent";
const TTL_MS = 30_000;
const DRAIN_CHUNK = 50;
const LEDGER_BATCH_CAP = 20;
/** Events waiting for fan-out. Past this the newest are dropped (activity is lossy), so a slow loop cannot grow the queue without bound. */
export const DERIVE_QUEUE_MAX = 2000;

export interface RequestActivityCtx {
  threadId?: string;
  subagent?: string;
  wolf?: string;
  /** Set after authentication: a worker token acts as a wolf, any other token is the owner. */
  worker?: boolean;
}

interface LedgerLike {
  type?: unknown;
  id?: unknown;
  to?: unknown;
  title?: unknown;
  domain?: unknown;
}

const one = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v;
  const t = typeof s === "string" ? s.trim().slice(0, 128) : "";
  return t || undefined;
};

export interface ActivityDeriverOptions {
  bus: ActivityBus;
  presence: PresenceStore;
  pack: string;
  now?: () => number;
  domainOf?: (workId: string) => string | undefined;
  stats?: ActivityStatsStore;
  queueMax?: number;
}

export function createActivityDeriver(o: ActivityDeriverOptions) {
  const als = new AsyncLocalStorage<RequestActivityCtx>();
  const now = o.now ?? Date.now;
  // Fan-out is off the write path: events queue FIFO and are published in chunks on later event-loop turns, so a big ledger batch
  // never writes to every SSE stream inside the Work API request.
  const queue: ActivityEvent[] = [];
  let draining = false;
  const drain = (): void => {
    draining = false;
    for (const ev of queue.splice(0, DRAIN_CHUNK)) {
      o.bus.publish(ev);
      o.stats?.add(ev.actor.wolf ?? ev.actor.kind, "derivedPublished");
    }
    if (queue.length) {
      draining = true;
      setImmediate(drain);
    }
  };

  const emit = (actor: ActivityActor, verb: ActivityVerb, target: ActivityEvent["target"], domain?: string, detail?: ActivityDetail): void => {
    const ev: ActivityEvent = {
      v: 1, id: randomUUID(), pack: o.pack, ts: now(), ttlMs: TTL_MS, actor, verb,
      ...(target ? { target } : {}), ...(domain ? { domain } : {}), ...(detail ? { detail } : {}),
    };
    try {
      if (actor.kind !== "hub") o.presence.set(ev); // hub trails are transient: no presence slot
    } catch {
      /* best effort */
    }
    if (queue.length >= (o.queueMax ?? DERIVE_QUEUE_MAX)) {
      o.stats?.add(actor.wolf ?? actor.kind, "queueDropped");
      return;
    }
    queue.push(ev);
    if (!draining) {
      draining = true;
      setImmediate(drain);
    }
  };

  const actorOf = (kind: "wolf" | "owner", wolf: string | undefined, ctx: RequestActivityCtx | undefined): ActivityActor | undefined => {
    if (kind === "owner") return { kind: "owner" };
    if (!wolf) return undefined;
    if (ctx?.subagent && ctx.threadId) return { kind: "subagent", wolf, threadId: ctx.threadId, subagent: ctx.subagent };
    if (ctx?.threadId) return { kind: "thread", wolf, threadId: ctx.threadId };
    return { kind: "wolf", wolf };
  };

  // curator items in flight: from/denTopicId -> start time (epoch ms), so curate-done can carry the elapsed ms. Bounded.
  const CURATING_MAX = 200;
  const curating = new Map<string, number>();
  const CURATOR_ACTOR: ActivityActor = { kind: "hub", title: "curator" };

  return {
    /**
     * The curator's per-item events (hub bus drafts) -> curate-start (first sweep_progress of an item) and curate-done (sweep_item).
     * The sweep carries no contribution id, so `detail.ref` is the den topic id (what the wolf's memory-promote event carries in topicIds).
     */
    onSweep(d: { type: string; from?: string; denTopicId?: string; startedAt?: number; outcome?: string; entryId?: string; domain?: string; section?: string; sectionTitle?: string }): void {
      try {
        if (d.type !== "sweep_progress" && d.type !== "sweep_item") return;
        if (!d.denTopicId || !d.from) return;
        const key = d.from + "/" + d.denTopicId;
        if (d.type === "sweep_progress") {
          if (curating.has(key)) return; // the route-known update of an item already announced
          if (curating.size >= CURATING_MAX) curating.delete(curating.keys().next().value as string); // evict the oldest, never the lot
          curating.set(key, typeof d.startedAt === "number" ? d.startedAt : now());
          emit(CURATOR_ACTOR, "curate-start", undefined, undefined, { ref: d.denTopicId, topicIds: [d.denTopicId] });
          return;
        }
        const startedAt = curating.get(key);
        curating.delete(key);
        const detail: ActivityDetail = {
          ref: d.denTopicId, topicIds: [d.denTopicId],
          ...(d.outcome ? { outcome: d.outcome } : {}),
          ...(d.section ? { section: d.section } : {}),
          ...(d.sectionTitle ? { sectionTitle: d.sectionTitle } : {}),
          ...(startedAt !== undefined ? { ms: Math.max(0, now() - startedAt) } : {}),
        };
        const target = d.entryId ? { kind: "kb-entry" as const, id: d.entryId, ...(d.domain ? { domain: d.domain } : {}) } : undefined;
        emit(CURATOR_ACTOR, "curate-done", target, d.domain, detail);
      } catch (e) {
        console.error("hubd: activity derive (sweep) failed:", (e as Error)?.message);
      }
    },
    /** Run one request inside its context. */
    run<T>(headers: Record<string, string | string[] | undefined>, fn: () => T): T {
      // The wolf is NOT read from X-Wolf (client-controlled): setWorker() sets it from the authenticated token.
      const ctx: RequestActivityCtx = { threadId: one(headers[THREAD_HEADER]), subagent: one(headers[SUBAGENT_HEADER]) };
      return als.run(ctx, fn);
    },
    /** After authentication: remember whether the caller is a worker (wolf) or the owner's console. */
    setWorker(worker: boolean, wolfId?: string): void {
      const c = als.getStore();
      if (c) {
        c.worker = worker;
        c.wolf = wolfId;
      }
    },
    /** Ledger events a write appended. `actor` is the write queue's actor (wolf id, operator or system). */
    onLedger(batch: { actor: { id: string; kind: string }; events: readonly LedgerLike[] }): void {
      try {
        const ctx = als.getStore();
        if (!ctx || batch.actor.kind === "system") return;
        const actor = actorOf(batch.actor.kind === "operator" ? "owner" : "wolf", batch.actor.id, ctx);
        if (!actor) return;
        const seen = new Set<string>();
        let derived = 0;
        for (const e of batch.events) {
          if (typeof e.id !== "string" || typeof e.type !== "string" || e.type === "work.deleted") continue;
          const verb: ActivityVerb = e.type === "work.staged" && (e.to === "shipped" || e.to === "live") ? "shipped" : "contribution";
          if (seen.has(verb + e.id)) continue;
          if (derived++ >= LEDGER_BATCH_CAP) break;
          seen.add(verb + e.id);
          const domain = typeof e.domain === "string" ? e.domain : o.domainOf?.(e.id);
          const title = typeof e.title === "string" ? sanitizeActivityTitle(e.title) : "";
          emit(actor, verb, { kind: "work-item", id: e.id, ...(domain ? { domain } : {}), ...(title ? { title } : {}) }, domain);
        }
      } catch (e) {
        console.error("hubd: activity derive (work) failed:", (e as Error)?.message);
      }
    },
    /** A KB commit landed for `domain`. With no request context (the hub's curator, system commits) the actor is the hub ("curator"). */
    onKb(entryIds: readonly string[], domain: string): void {
      try {
        const ctx = als.getStore();
        if (ctx && ctx.worker === undefined) return; // a request that has not authenticated yet
        const actor: ActivityActor | undefined = ctx ? actorOf(ctx.worker ? "wolf" : "owner", ctx.wolf, ctx) : { kind: "hub", title: "curator" };
        if (!actor) return;
        for (const id of entryIds.slice(0, 20)) emit(actor, "kb-write", { kind: "kb-entry", id, domain }, domain);
      } catch (e) {
        console.error("hubd: activity derive (kb) failed:", (e as Error)?.message);
      }
    },
  };
}
