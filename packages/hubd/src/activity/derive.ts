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
import { sanitizeActivityTitle, type ActivityActor, type ActivityEvent, type ActivityVerb } from "@wolfpack/protocol";
import type { ActivityBus } from "./bus.js";
import type { PresenceStore } from "./presence.js";

export const THREAD_HEADER = "x-wolfpack-thread-id";
export const SUBAGENT_HEADER = "x-wolfpack-subagent";
const TTL_MS = 30_000;

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
}

export function createActivityDeriver(o: ActivityDeriverOptions) {
  const als = new AsyncLocalStorage<RequestActivityCtx>();
  const now = o.now ?? Date.now;

  const emit = (actor: ActivityActor, verb: ActivityVerb, target: ActivityEvent["target"], domain?: string): void => {
    const ev: ActivityEvent = {
      v: 1, id: randomUUID(), pack: o.pack, ts: now(), ttlMs: TTL_MS, actor, verb,
      ...(target ? { target } : {}), ...(domain ? { domain } : {}),
    };
    try {
      o.presence.set(ev);
    } catch {
      /* best effort */
    }
    o.bus.publish(ev);
  };

  const actorOf = (kind: "wolf" | "owner", wolf: string | undefined, ctx: RequestActivityCtx | undefined): ActivityActor | undefined => {
    if (kind === "owner") return { kind: "owner" };
    if (!wolf) return undefined;
    if (ctx?.subagent && ctx.threadId) return { kind: "subagent", wolf, threadId: ctx.threadId, subagent: ctx.subagent };
    if (ctx?.threadId) return { kind: "thread", wolf, threadId: ctx.threadId };
    return { kind: "wolf", wolf };
  };

  return {
    /** Run one request inside its context. */
    run<T>(headers: Record<string, string | string[] | undefined>, fn: () => T): T {
      const ctx: RequestActivityCtx = { threadId: one(headers[THREAD_HEADER]), subagent: one(headers[SUBAGENT_HEADER]), wolf: one(headers["x-wolf"]) };
      return als.run(ctx, fn);
    },
    /** After authentication: remember whether the caller is a worker (wolf) or the owner's console. */
    setWorker(worker: boolean): void {
      const c = als.getStore();
      if (c) c.worker = worker;
    },
    /** Ledger events a write appended. `actor` is the write queue's actor (wolf id, operator or system). */
    onLedger(batch: { actor: { id: string; kind: string }; events: readonly LedgerLike[] }): void {
      try {
        const ctx = als.getStore();
        if (!ctx || batch.actor.kind === "system") return;
        const actor = actorOf(batch.actor.kind === "operator" ? "owner" : "wolf", batch.actor.id, ctx);
        if (!actor) return;
        const seen = new Set<string>();
        for (const e of batch.events) {
          if (typeof e.id !== "string" || typeof e.type !== "string" || e.type === "work.deleted") continue;
          const verb: ActivityVerb = e.type === "work.staged" && (e.to === "shipped" || e.to === "live") ? "shipped" : "contribution";
          if (seen.has(verb + e.id)) continue;
          seen.add(verb + e.id);
          const domain = typeof e.domain === "string" ? e.domain : o.domainOf?.(e.id);
          const title = typeof e.title === "string" ? sanitizeActivityTitle(e.title) : "";
          emit(actor, verb, { kind: "work-item", id: e.id, ...(domain ? { domain } : {}), ...(title ? { title } : {}) }, domain);
        }
      } catch (e) {
        console.error("hubd: activity derive (work) failed:", (e as Error)?.message);
      }
    },
    /** A KB commit landed for `domain`. Nothing without a request context (the curator's own commits). */
    onKb(entryIds: readonly string[], domain: string): void {
      try {
        const ctx = als.getStore();
        if (!ctx || ctx.worker === undefined) return;
        const actor = actorOf(ctx.worker ? "wolf" : "owner", ctx.wolf, ctx);
        if (!actor) return;
        for (const id of entryIds.slice(0, 20)) emit(actor, "kb-write", { kind: "kb-entry", id, domain }, domain);
      } catch (e) {
        console.error("hubd: activity derive (kb) failed:", (e as Error)?.message);
      }
    },
  };
}
