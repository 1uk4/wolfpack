/**
 * tuning.ts — NUMERIC KNOBS (editable configuration).
 *
 * Every threshold, weight, and parameter the deterministic engine uses, in one
 * place, so you can tune behavior as you see what works — without touching logic.
 * Nothing here is an LLM decision; these are the code-owned dials.
 *
 * Pair with: vocab.ts (what the LLM may choose) and prompts.ts (how it's asked).
 */

/** Local embedding model (served by Ollama where the librarian runs). */
export const EMBED = {
  /** Overridable via WOLFPACK_EMBED_URL. */
  baseUrl: "http://localhost:11434",
  /** Overridable via WOLFPACK_EMBED_MODEL. Changing it forces a cache rebuild. */
  model: "nomic-embed-text",
  /** Max chars of (title+body) fed to the embedder. */
  inputMaxChars: 4000,
} as const;

/**
 * Hierarchical section tree mechanics (KB v2). Controls how entries are placed
 * into the single-parent section backbone, when sections split on overflow, and
 * when novel clusters crystallize into new sections from _unplaced.
 */
/**
 * Sweep batching. The sweep timer fires on a schedule (every 15 min on the VPS);
 * each run processes at most `batchSize` contributions (oldest first) so a large
 * multi-wolf inbox can never make a single run exhaust the server (LLM calls,
 * memory, runtime, rate limits). The remainder waits for the next tick and the
 * backlog drains steadily. Override per host with the KB_SWEEP_BATCH env var.
 */
export const SWEEP = {
  batchSize: 25,
  /** cosine \u2265 this to an existing entry \u2192 same topic: UPDATE it (and seed its
   *  registry alias) rather than create a duplicate. The ALIAS is the primary
   *  deterministic identity; this similarity seed only matters for entries that
   *  have no alias yet (e.g. migrated ones on first re-promote).
   *  TODO(calibrate): nomic-embed has a COMPRESSED range \u2014 0.85 was too high (a
   *  real re-promote scored below it and duplicated). Calibrate against real
   *  re-promotes on Dewey; the old v1 estimate was ~0.75 for "same topic". */
  mergeSim: 0.72,
} as const;

export const HIERARCHY = {
  /** Below this cosine to any child centroid → park in _unplaced. */
  fitThreshold: 0.78,
  /** Section members over this count → split (BIRCH-style overflow). */
  splitAt: 8,
  /** Section under this count → fold back into parent. */
  mergeBelow: 3,
  /** Parked entries forming a cohesive cluster → new section. */
  crystallizeAt: 4,
  /** Silhouette floor for a crystallized section to be valid. */
  minCohesion: 0.80,
  /** Cap tree descent depth. */
  maxDepth: 4,
  /** How often the tree is rebuilt/rebalanced. */
  rebuildCadence: "weekly" as const,
  /** Max child summaries fed into a section-summary LLM call (bounded context). */
  maxChildSummaries: 12,
} as const;

/**
 * Relation derivation (the two-layer link model) — how many and how strong the
 * auto-`see_also` edges are, and the confidence floor for keeping an LLM edge.
 */
export const RELATIONS = {
  /** Max embedding-derived see_also edges written per entry. */
  maxSeeAlso: 5,
  /** Min cosine for an auto see_also edge. */
  seeAlsoMinSim: 0.74,
  /** Max LLM-proposed semantic edges accepted per entry (after resolution). */
  maxProposed: 8,
} as const;

/**
 * Maturity derivation (Library). Deterministic defaults; curator may override.
 *  - a hub becomes `canonical`
 *  - an entry below `stubIntegration` connectivity is a `stub` (a gap)
 *  - low-confidence content is a `draft`
 */
export const MATURITY_RULES = {
  stubIntegration: 0.15,
} as const;

/**
 * Context digest (DESIGN — see kb/shared/schemas/digest.ts). How much of the
 * pack's existing knowledge Dewey briefs a wolf with at consolidation time.
 * Keep lean: summaries, not bodies. Selection is title/keyword match wolf-side
 * (no embeddings needed there).
 */
export const DIGEST = {
  /** Max canonical topics included in a domain digest. */
  maxTopics: 60,
  /** Max topics actually injected into a single consolidation prompt (the
   *  relevant subset for the topics being consolidated). */
  maxPrimedTopics: 8,
  /** Include the gap list once the health loop lands. */
  includeGaps: false,
} as const;

