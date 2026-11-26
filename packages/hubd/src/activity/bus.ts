/**
 * The activity EventBus: the seam between ingest and everything that listens (presence store, SSE fan-out). Only the in-memory
 * adapter exists; a Redis Streams adapter implements the same interface later (P3) without touching callers.
 *
 * Contract: `publish` never has to be awaited and may throw (callers go through `guardBus`); `subscribe` is per pack, so a
 * subscriber of pack A can never see pack B. One throwing subscriber never blocks the others.
 */
import type { ActivityEvent } from "@wolfpack/protocol";

export interface ActivityBus {
  publish(event: ActivityEvent): void;
  subscribe(pack: string, fn: (event: ActivityEvent) => void): () => void;
}

export function createMemoryBus(): ActivityBus {
  const byPack = new Map<string, Set<(e: ActivityEvent) => void>>();
  return {
    publish(event) {
      const subs = byPack.get(event.pack);
      if (!subs) return;
      for (const fn of [...subs]) {
        try {
          fn(event);
        } catch (e) {
          console.error("hubd: activity subscriber failed:", (e as Error).message);
        }
      }
    },
    subscribe(pack, fn) {
      let subs = byPack.get(pack);
      if (!subs) byPack.set(pack, (subs = new Set()));
      subs.add(fn);
      return () => {
        const s = byPack.get(pack);
        if (!s) return;
        s.delete(fn);
        if (s.size === 0) byPack.delete(pack);
      };
    },
  };
}

const LOG_EVERY_MS = 60_000;

/**
 * Wrap a bus so that nothing it throws reaches a caller: publish failures are swallowed (logged at most once a minute) and a failing
 * subscribe returns a no-op unsubscribe. The Work API and KB never depend on the bus.
 */
export function guardBus(inner: ActivityBus, now: () => number = Date.now): ActivityBus {
  let lastLog = -Infinity;
  const fail = (what: string, e: unknown) => {
    const t = now();
    if (t - lastLog < LOG_EVERY_MS) return;
    lastLog = t;
    console.error(`hubd: activity bus ${what} failed (further failures muted for 60s):`, (e as Error)?.message ?? e);
  };
  return {
    publish(event) {
      try {
        inner.publish(event);
      } catch (e) {
        fail("publish", e);
      }
    },
    subscribe(pack, fn) {
      try {
        return inner.subscribe(pack, fn);
      } catch (e) {
        fail("subscribe", e);
        return () => {};
      }
    },
  };
}
