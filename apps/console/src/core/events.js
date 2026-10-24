/**
 * THE EVENT BUS (push-architecture slice 1, owner ruling 2026-10-02: go
 * directly to the endgame — notify → fetch, no standing polls).
 *
 * One bus, every layer: server emits turn lifecycle here, the store
 * adapters emit job/chat mutations, the agent layer's background
 * registries (extraction) emit activity changes — and
 * GET /api/events turns every emission into an SSE frame for any open
 * window. The events carry the FACT, never the data: consumers fetch
 * truth on receipt (push the poke, pull the data), so payloads stay
 * tiny, schemaless, and idempotent — a reconnect heals by refetching.
 *
 * WHY globalThis (the turn-liveness discipline, same rationale): Next
 * dev compiles each route as its own module entry, so a module-level
 * singleton is a DIFFERENT instance in the page render, the events
 * route, and every emitter's entry — they would each hold a private
 * listener set and nothing would propagate. globalThis spans module
 * instances within the process; it is the standard Next singleton
 * channel (see src/server/turn-liveness.ts for the original incident).
 *
 * Pure core by law: no React, no IO, no imports — the one layer that
 * server, store, and agent may all depend on.
 */
/** The vocabulary's runtime names — the client wires one listener per
 *  name (types are erased; this list is the single source of truth for
 *  what the SSE channel can carry). */
export const SERVER_EVENT_TYPES = [
    "turn-started",
    "turn-settled",
    "jobs-changed",
    "activity-changed",
    "chats-changed",
    "record-changed",
    "compaction-changed",
];
/** The shared listener set — globalThis-backed so every Next module entry
 *  (and every layer) sees ONE bus. Ephemeral by design: a process restart
 *  drops the listeners with their connections; emitters never queue. */
function listeners() {
    const g = globalThis;
    return (g.__lhEventBus ??= new Set());
}
/** Listen. Returns the unsubscribe function — the SSE route's cancel and
 *  any test cleanup call it; a dropped listener leaks nothing. */
export function subscribe(listener) {
    const set = listeners();
    set.add(listener);
    return () => set.delete(listener);
}
/** Notify every listener. Zero subscribers is a no-op (no window open —
 *  the emission was for the stores' own bookkeeping anyway). One
 *  listener throwing must never break the others or the emitter: each
 *  call is isolated, the failure logged, the loop continues. */
export function emit(type, payload) {
    // Snapshot: a listener that unsubscribes (or subscribes) mid-emit must
    // not mutate the set under iteration.
    for (const listener of [...listeners()]) {
        try {
            listener({ type, ...payload });
        }
        catch (err) {
            console.error(`[events] listener failed on ${type}:`, err);
        }
    }
}
//# sourceMappingURL=events.js.map