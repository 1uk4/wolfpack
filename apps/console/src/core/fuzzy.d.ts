/**
 * Fuzzy search scoring (model-control wave, 2026-09-12) — pi's `/model`
 * picker pattern: space-separated tokens, each token must match SOME field
 * (case-insensitive substring), ranked so exact field matches beat
 * prefixes beat buried substrings. Pure core; the picker sorts by score.
 */
/** Score one candidate, or null when any token matches no field.
 *  Higher is better; ties break naturally by list order (stable sort).
 *
 *  Per-token points: exact field equality 100 · field startsWith 60 ·
 *  substring 30 minus a depth penalty (earlier finds win). Whole-query
 *  contiguity in one field adds +50 (query "glm flash" vs the id
 *  "z-ai/glm-5.3-flash" loses to a model whose id contains "glm flash"
 *  verbatim — as it should). */
export declare function fuzzyScore(query: string, ...fields: string[]): number | null;
//# sourceMappingURL=fuzzy.d.ts.map