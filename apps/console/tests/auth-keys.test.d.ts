/**
 * The curated auth-key catalog + shape rules (auth-keys wave, 2026-09-19;
 * search wave 2026-09-20: the Google CSE pair retired, Tavily + Brave in)
 * — PURE module, so this file owns no fs. Owner decisions being pinned:
 *  - the catalog is exactly the three known keys, ids = env-var names;
 *  - validation is SHAPE-ONLY (no live pings) and bad pastes are 400s;
 *  - masking is last-4 + length — plaintext never leaves the store.
 */
export {};
//# sourceMappingURL=auth-keys.test.d.ts.map