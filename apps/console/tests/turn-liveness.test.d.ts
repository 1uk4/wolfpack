/**
 * Turn liveness registry unit tests (src/server/turn-liveness.ts): one turn
 * per chat, ever — begin/end round trip, double-begin rejection, restart
 * after end. The 30-minute stale-eviction TTL is not tested (it is a leak
 * guard, not a behavior). The lifecycle-emitter pins ride the same seams:
 * turn-started on the accepted begin only, turn-settled on the live end
 * only, and the registry already consistent when the listener runs.
 */
export {};
//# sourceMappingURL=turn-liveness.test.d.ts.map