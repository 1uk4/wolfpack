/**
 * provider-events — the raw-wire recorder pins (owner, 2026-10-04).
 *
 * The recorder is env-gated debug tooling (LH_PROVIDER_EVENTS=1); these
 * pins hold its mechanics: off = zero surface (no observer, no file),
 * on = one JSONL per chat under data/debug/provider-events/, safe
 * degradation on non-serializable adapter payloads, and the byte cap
 * that stops a runaway turn from filling the disk.
 */
export {};
//# sourceMappingURL=provider-events.test.d.ts.map