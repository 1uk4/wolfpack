/**
 * Presence store: the last activity event per actor (pack + wolf / thread / subagent / owner), forgotten `ttlMs` after the hub
 * received it (hub clock, so a wolf's skewed clock cannot pin or kill an entry). O(1) per event; bounded (oldest evicted);
 * expiry is a lazy sweep on read plus one unref'd interval.
 */
import { ACTIVITY_VERSION, type ActivityEvent, type PresenceEntry, type PresenceSnapshot } from "@wolfpack/protocol";

export const PRESENCE_MAX_ENTRIES = 5000;
const SWEEP_MS = 5000;

/** State-bearing verbs each own a slot per actor (a later verb of the same slot replaces it); transient verbs share one slot. */
const SLOT: Partial<Record<ActivityEvent["verb"], string>> = {
  "thread-active": "activity", "thread-idle": "activity",
  "needs-you": "needs", answered: "needs",
  bound: "binding", unbound: "binding",
  "subagent-spawned": "subagent", "subagent-finished": "subagent",
  "owner-viewing": "viewing",
  "wolf-online": "wolf", "wolf-offline": "wolf",
};

const keyOf = (e: ActivityEvent): string => {
  const a = e.actor;
  return [e.pack, a.kind, a.wolf ?? "", a.threadId ?? "", a.subagent ?? "", SLOT[e.verb] ?? "transient"].join("\u0000");
};

export function createPresenceStore(opts: { now?: () => number; maxEntries?: number; sweepMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const max = opts.maxEntries ?? PRESENCE_MAX_ENTRIES;
  const map = new Map<string, PresenceEntry>(); // insertion order = oldest first
  const sweep = () => {
    const t = now();
    for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k);
  };
  const timer = setInterval(sweep, opts.sweepMs ?? SWEEP_MS);
  timer.unref();
  return {
    set(event: ActivityEvent): void {
      const k = keyOf(event);
      map.delete(k); // re-insert at the end: most recently active last
      if (event.verb === "wolf-offline") return; // a clean shutdown forgets the wolf slot at once
      map.set(k, { event, expiresAt: now() + event.ttlMs });
      if (map.size > max) map.delete(map.keys().next().value as string);
    },
    snapshot(pack: string): PresenceSnapshot {
      sweep();
      const snap: PresenceSnapshot = { v: ACTIVITY_VERSION, pack, at: now(), wolves: [], threads: [], subagents: [], owner: [] };
      for (const v of map.values()) {
        if (v.event.pack !== pack) continue;
        const kind = v.event.actor.kind;
        (kind === "wolf" ? snap.wolves : kind === "thread" ? snap.threads : kind === "subagent" ? snap.subagents : snap.owner).push(v);
      }
      return snap;
    },
    get size(): number {
      return map.size;
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
export type PresenceStore = ReturnType<typeof createPresenceStore>;
