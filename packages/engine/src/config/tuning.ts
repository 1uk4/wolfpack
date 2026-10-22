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
 * Sweep pacing. The sweep timer fires every minute; each run processes exactly
 * one contribution (oldest first), so the next one is picked up within a minute
 * and one run can never exhaust the server (LLM calls, memory, runtime, rate
 * limits). That contribution gets the whole run budget.
 */
export const SWEEP = {
  /** cosine \u2265 this to an existing entry \u2192 same topic: UPDATE it (and seed its
   *  registry alias) rather than create a duplicate. The ALIAS is the primary
   *  deterministic identity; this similarity seed only matters for entries that
   *  have no alias yet (e.g. migrated ones on first re-promote).
   *  TODO(calibrate): nomic-embed has a COMPRESSED range \u2014 0.85 was too high (a
   *  real re-promote scored below it and duplicated). Calibrate against real
   *  re-promotes on Dewey; the old v1 estimate was ~0.75 for "same topic". */
  mergeSim: 0.72,
  /**
   * Estimated milliseconds per character of LLM output during merge operations.
   * Used to compute the merge threshold from the run budget.
   * Calibrate from observed sweep times (12KB entry merged in 145s = ~12ms/char).
   */
  msPerMergeChar: 15,
  
  /**
   * Fraction of the run budget allocated to the merge LLM call.
   * The rest covers embedding, routing, and overhead.
   * maxMergeChars = (runBudgetMs * mergeBudgetFraction) / msPerMergeChar
   */
  mergeBudgetFraction: 0.6,
  
  /** Failed attempts (across ticks) before a contribution is parked. */
  maxAttempts: 3,
  /** Time budget for a run's one contribution: past it the item is parked, so a
   *  run always ends (and writes its ledger) well inside systemd's 15-minute
   *  limit. Merge threshold: 600s * 0.6 / 15ms = 24,000 chars. */
  runBudgetMs: 600_000,
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
 * SECTION TREE ALGORITHM
 *
 * Controls how the knowledge base section hierarchy is built, maintained, and
 * rebalanced. The tree serves as a navigable taxonomy: entries are leaves,
 * sections are internal nodes, and the root is the domain itself.
 *
 * The algorithm has two modes:
 *
 * 1. FULL REBUILD (agglomerative bottom-up)
 *    Triggered manually via `kb_reorg --rebuild` or when drift exceeds threshold.
 *    Starts with each entry as its own cluster, merges the most similar pair
 *    repeatedly until target root count is reached. The merge history becomes
 *    the tree hierarchy — early merges are leaf sections, late merges are roots.
 *    Produces weight-correct trees (parents always heavier than children).
 *
 * 2. INCREMENTAL PLACEMENT (recursive descent + split)
 *    Runs every sweep when new entries arrive. Descends the tree from root,
 *    choosing the child with highest centroid similarity at each level. Stops
 *    when the entry's abstraction level matches its siblings. If a section
 *    overflows, splits into parent (larger/more general) + child (smaller/
 *    more specific) rather than two siblings.
 *
 * INVARIANTS checked after every mutation:
 *   - Weight: total_entries(parent) >= total_entries(child)
 *   - Singleton roots: no root section below minRootRatio of domain entries
 *   - Cohesion: intra-section similarity above cohesion threshold
 *
 * SECTION NAMING:
 *   - Depth 0-2: LLM-generated, weighted by child entry count
 *   - Depth 3+: auto-generated from member entry titles (no LLM cost)
 *   - Parent titles are weighted generalizations — a 50-entry child
 *     contributes 50x more to the parent's name than a 1-entry child
 */
export const SECTION_TREE = {

  // ── Placement: recursive descent ──────────────────────────────────────

  /**
   * Abstraction scores by entry kind.
   * Controls how deep an entry is placed. Lower = stays shallow (general),
   * higher = descends deep (specific). The score is compared against
   * normalized depth (node.depth / tree.maxDepth).
   *
   * Example: an `architecture` entry (0.15) stops at the top 15% of the tree.
   * A `fact` entry (0.9) descends to the bottom 10%.
   */
  abstractionByKind: {
    architecture: 0.15,
    overview: 0.20,
    reference: 0.25,
    decision: 0.40,
    process: 0.50,
    product: 0.50,
    policy: 0.55,
    changelog: 0.70,
    incident: 0.80,
    fact: 0.90,
  } as Record<string, number>,

  /**
   * Default abstraction score when entry kind is not in the map.
   * 0.5 = middle of the tree.
   */
  defaultAbstraction: 0.50,

  /**
   * Maturity adjustment. Multiplied against abstraction score.
   * Established entries get placed with more confidence (score unchanged).
   * Stubs are pushed slightly deeper (higher score = deeper) to avoid
   * polluting shallow sections with incomplete knowledge.
   */
  maturityMultiplier: {
    established: 1.0,
    forming: 1.0,
    stub: 1.15,
  } as Record<string, number>,

  // ── New section creation (outlier detection) ──────────────────────────

  /**
   * Minimum cosine similarity to any existing root section centroid.
   * Below this = entry is an outlier that doesn't fit anywhere.
   * Outliers accumulate in the unplaced pool until they can crystallize.
   *
   * Scales with domain maturity: as sections become denser, this threshold
   * rises because the domain's topics are well-covered.
   */
  isolationThreshold: 0.65,

  /**
   * Minimum entries in the unplaced pool before attempting crystallization.
   * Higher = harder to create new sections (more evidence needed).
   */
  crystallizeMinEntries: 4,

  /**
   * Minimum pairwise cosine similarity within the unplaced cluster
   * for it to qualify as a new section. Must be cohesive, not just
   * "a pile of things that don't fit elsewhere."
   */
  crystallizeCohesion: 0.80,

  // ── Splitting (section overflow) ──────────────────────────────────────

  /**
   * When a section exceeds this many entries, split into parent + child.
   * The larger cluster stays as parent, smaller becomes child.
   * (Same as HIERARCHY.splitAt but used by the new algorithm.)
   */
  splitThreshold: 8,

  /**
   * Maximum children per section. When a section has more children than
   * this, group them into intermediate sub-sections via k-means on
   * children centroids. Keeps the tree navigable (Miller's number: 3-7).
   *
   * k = ceil(numChildren / maxChildrenPerSection)
   */
  maxChildrenPerSection: 6,

  /**
   * When splitting, how to choose which cluster becomes the parent:
   * - "domain_centrality": cluster whose centroid is closer to the domain
   *   centroid becomes parent (more general = parent). Preferred.
   * - "size": larger cluster becomes parent. Simpler fallback.
   */
  splitParentStrategy: "domain_centrality" as "domain_centrality" | "size",

  /**
   * Minimum members on the smaller side of a post-split. If a split would
   * produce a side with fewer than this, the section is left as a leaf
   * even if it exceeds splitThreshold. Prevents imbalanced splits
   * (8+1, 8+2) that just orphan a semantic outlier under a fresh wrapper.
   *
   * Rule of thumb: splitThreshold / 3 (so 3 at splitThreshold=8).
   */
  splitMinBalance: 3,

  // ── Singleton absorption ──────────────────────────────────────────────

  /**
   * Root sections with fewer than this fraction of total domain entries
   * are absorbed into their nearest centroid neighbor.
   *
   * At 60 entries: 0.05 * 60 = 3 entry minimum per root section.
   * At 600 entries: 0.05 * 600 = 30 entry minimum.
   * Scales naturally with domain growth.
   */
  minRootRatio: 0.05,

  /**
   * After the singleton-root absorb pass, any two roots whose centroids
   * exceed this cosine similarity are collapsed into one — the smaller
   * becomes a child of the larger. Catches cases where two roots are
   * semantically overlapping (e.g. "Pi-Durable Infrastructure" and
   * "Pi Durable Integration") but both independently clear minRootRatio.
   *
   * Set high (0.92+) because within a single domain, all centroids are
   * naturally similar — only merge truly redundant pairs. The pass also
   * respects a root-count floor derived from rootCountFactor so it never
   * collapses more than needed to reach the target root count.
   */
  rootMergeSimilarity: 0.92,

  // ── Wrapper collapse ───────────────────────────────────────────────

  /**
   * If a grouping section (0 direct entries) has one child containing at
   * least this fraction of all descendant entries, the wrapper is removed
   * and its children promoted to the wrapper's parent. Prevents redundant
   * "wrapper named after its dominant child" chains.
   */
  dominantChildThreshold: 0.80,

  // ── Promotion ─────────────────────────────────────────────────────────

  /**
   * An entry is a promotion candidate when its cosine similarity to its
   * PARENT section's centroid exceeds its similarity to its CURRENT
   * section's centroid by this margin.
   *
   * High margin = conservative (rarely promotes).
   * Low margin = aggressive (entries bubble up easily).
   */
  promotionMargin: 0.10,

  /**
   * Minimum number of entries that must promote together.
   * Single-entry promotion is noisy; group promotion (community split)
   * is more meaningful.
   */
  promotionMinGroup: 2,

  // ── Centroid recalculation (drift detection) ──────────────────────────

  /**
   * Recalculate all section centroids when the fraction of entries that
   * have been added, retired, or moved since last recalculation exceeds
   * this threshold.
   *
   * At 60 entries: triggers after 6 mutations.
   * At 600 entries: triggers after 60 mutations.
   * Prevents stale centroids from accumulating placement errors.
   */
  driftRecalcThreshold: 0.10,

  // ── Naming ────────────────────────────────────────────────────────────

  /**
   * Maximum tree depth at which sections get LLM-generated titles.
   * Sections deeper than this get auto-titles from member entry titles.
   * Controls LLM cost during rebuilds.
   *
   * Depth 0 = root sections, depth 1 = first-level children, etc.
   */
  llmNamingMaxDepth: 4,

  /**
   * When generating a parent section title, child sections are weighted
   * by their entry count raised to this power.
   *
   * 1.0 = linear weighting (7-entry child has 7x influence over 1-entry child)
   * 0.5 = sqrt weighting (softer, 7-entry child has 2.6x influence)
   * 0.0 = equal weighting (all children contribute equally, current behavior)
   */
  titleWeightExponent: 1.0,

  // ── Embedding model health ────────────────────────────────────────────

  /**
   * Minimum ratio of mean intra-section similarity to mean inter-section
   * similarity. Below this, the embedding model isn't capturing domain
   * distinctions well enough and should be upgraded.
   *
   * Above 1.3 = good separation.
   * 1.1 - 1.3 = marginal.
   * Below 1.1 = model upgrade recommended.
   */
  embeddingHealthMinRatio: 1.3,

  // ── Full rebuild ──────────────────────────────────────────────────────

  /**
   * Target number of root sections as a fraction of sqrt(total_entries).
   * Agglomerative merge stops when this many clusters remain.
   *
   * At 60 entries: sqrt(60) * 0.8 ≈ 6 root sections.
   * At 600 entries: sqrt(600) * 0.8 ≈ 20 root sections.
   * At 5000 entries: sqrt(5000) * 0.8 ≈ 57 root sections.
   */
  rootCountFactor: 0.8,

} as const;

/**
 * Crawl pipeline size budgets. Caps the LLM-generated body of each crawl
 * topic so a bloated source never flows straight into the KB as a 20k+ entry.
 *
 *  - bodyTargetChars: soft target surfaced in the consolidation prompt.
 *  - bodyMaxChars:    hard cap enforced by CrawlTopicSchema; overflow triggers
 *                     the engine's self-correcting retry loop.
 */
export const CRAWL = {
  bodyTargetChars: 5000,
  bodyMaxChars: 8000,
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

