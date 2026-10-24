/**
 * PARKED DISMISSALS (owner, 2026-10-04): ESC-discard while the turn is
 * still working. Mid-turn the stored record holds no pending question or
 * problem (the turn's messages land at settle), so the dismiss route
 * cannot validate — it PARKS the intent (202) and the turn's settle path
 * applies it against the freshly persisted record, only if the dismissed
 * thing really is pending there.
 *
 * These pins hold both halves: the pure park registry + apply against
 * fixture records, and the route's park contract under an isolated
 * LH_DATA_DIR (the birth-stamp discipline — the seam is set before any
 * config-loading import, every app-module import dynamic).
 */
export {};
//# sourceMappingURL=dismissal-park.test.d.ts.map