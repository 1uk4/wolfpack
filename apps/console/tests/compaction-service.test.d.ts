/**
 * THE COMPACTION SERVICE (owner round 14, 2026-10-05): the trigger
 * plumbing — settle kick + turn-start gate, the registry mutex, the
 * summary call, usage, events. Pinned here with an injected summarizer
 * (the sub-agent one-shot needs a live engine; the SERVICE laws don't).
 *
 * The laws:
 * - the registry is a mutex: concurrent ensureCompacted → ONE summary;
 * - over-threshold → marker appended + usage logged + events emitted;
 * - under-threshold (or the projection post-marker) → no-op;
 * - chained compaction: the span carries the prior summary forward;
 * - the effective threshold: min(setting, window − reserve).
 */
export {};
//# sourceMappingURL=compaction-service.test.d.ts.map