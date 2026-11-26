/**
 * POST /v1/activity core: per-token rate limit, actor ownership checks, pack stamping, then publish on the bus.
 * Never throws for bad input (it counts a drop) and never lets a bus/presence failure escape.
 */
import { parseActivityBatch, type ActivityEvent, type ActivityIngestResponse } from "@wolfpack/protocol";
import { HubError } from "../errors.js";
import type { ActivityBus } from "./bus.js";
import type { PresenceStore } from "./presence.js";

export const ACTIVITY_BODY_LIMIT = 64 * 1024;
export const DEFAULT_RATE_PER_SEC = 20;
export const DEFAULT_BURST = 100;
/** Rate-limit buckets kept (one per token). When full, the oldest-inserted bucket is evicted: that token simply restarts with a full burst. 10k tokens is far beyond any real pack, so eviction is a memory bound, not a limiter. */
const MAX_BUCKETS = 10_000;

/** Who is publishing: a worker token (its host), or any other device token (console / browser: owner events only). */
export interface Publisher {
  tokenId: string;
  hostId?: string;
  worker: boolean;
}

export interface IngestOptions {
  bus: ActivityBus;
  presence: PresenceStore;
  /** The hub's pack id: every accepted event is stamped with it, whatever the client sent. */
  pack: string;
  /** Is `wolf` an active wolf registered on `hostId`? */
  wolfOnHost: (wolf: string, hostId: string) => boolean;
  now?: () => number;
  ratePerSec?: number;
  burst?: number;
}

export function createActivityIngest(o: IngestOptions) {
  const now = o.now ?? Date.now;
  const rate = o.ratePerSec ?? DEFAULT_RATE_PER_SEC;
  const burst = o.burst ?? DEFAULT_BURST;
  const bus = o.bus; // the hub passes a guardBus-wrapped bus: publish never throws
  const buckets = new Map<string, { tokens: number; at: number }>();

  /** Token bucket: how many of `want` events may pass now. */
  const take = (id: string, want: number): number => {
    const t = now();
    let b = buckets.get(id);
    if (!b) {
      b = { tokens: burst, at: t };
      if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value as string);
      buckets.set(id, b);
    }
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * rate);
    b.at = t;
    const n = Math.min(want, Math.floor(b.tokens));
    b.tokens -= n;
    return n;
  };

  const allowed = (e: ActivityEvent, who: Publisher): boolean => {
    if (e.actor.kind === "owner") return !who.worker;
    // A worker token is per HOST, not per wolf, so it may speak for any sibling wolf registered on its own host. Accepted for now:
    // the host is one trust unit (its wolves share a machine and a token file); it can never speak for a wolf on another host.
    if (!who.worker || !who.hostId || !e.actor.wolf) return false;
    return o.wolfOnHost(e.actor.wolf, who.hostId);
  };

  return {
    ingest(who: Publisher, body: unknown): ActivityIngestResponse {
      const raw = (body as { events?: unknown } | null)?.events;
      // The hub owns `pack`: set it on every raw event BEFORE validation (wolfd sends "" because it does not know the pack name).
      const stamped = Array.isArray(raw) ? raw.map((x) => (x && typeof x === "object" ? { ...(x as object), pack: o.pack } : x)) : raw;
      const parsed = parseActivityBatch(stamped);
      if (!parsed.ok) throw new HubError("invalid_request", parsed.reason === "too-large" ? "too many events in one batch" : "events must be an array");
      const total = Array.isArray(raw) ? raw.length : 0;
      const room = take(who.tokenId, parsed.events.length);
      let accepted = 0;
      for (const ev of parsed.events.slice(0, room)) {
        if (!allowed(ev, who)) continue;
        try {
          o.presence.set(ev);
        } catch {
          /* presence is best effort */
        }
        bus.publish(ev);
        accepted++;
      }
      return { accepted, dropped: total - accepted };
    },
  };
}
