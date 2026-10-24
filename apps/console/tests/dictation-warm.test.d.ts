/**
 * Unit tests — the dictation warm-token cache (mitigation D, owner
 * 2026-09-27: components/dictation.tsx createWarmMinter).
 *
 * The click path takes the cached promise instead of a remote mint, so
 * the cache's behavior IS the felt start latency: one mint per warm
 * window, honest re-mint on failure, TTL so a stale token is never
 * served, and refresh() warming the next run in the background.
 */
export {};
//# sourceMappingURL=dictation-warm.test.d.ts.map