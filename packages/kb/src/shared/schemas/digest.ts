/**
 * digest.ts — the CONTEXT DIGEST contract (DESIGN; not yet wired).
 *
 * The fix for "Dewey should help produce better observations & consolidations."
 * A wolf (live) or a scribe (crawl) otherwise works BLIND to what the pack
 * already knows — even though the curated entries are in the Syncthing mirror and
 * wolves can read them. This contract is how Dewey
 * *briefs the researcher before they write*, on BOTH ingestion paths.
 *
 *   Dewey sweep ──(regenerates per domain, like INDEX)──▶ domains/<d>/_digest.json
 *          │                                                      │  Syncthing mirror
 *          ▼                                                      ▼
 *   canonical topics + summaries + vocab + gaps + journey   consumed by both paths
 *
 * ── PATH A · LIVE memory (per wolf) ──────────────────────────────────────────
 *   NOT WIRED. Den promotion is a deterministic upsert (no LLM), so the old
 *   priming point is gone. If revived, inject the "PACK ALREADY KNOWS" block
 *   into the session consolidation prompt (orchestrator.ts) → KB-aware delta:
 *     · merge vs restate   · correct domain/kind at source
 *     · real references/see_also ids   · targets gaps
 *
 * ── PATH B · CRAWL (scribe, historical/batch) ────────────────────────────────
 *   Same two priming points, plus three crawl-specific behaviors:
 *     1. EXTEND-THE-REAL-ENTRY: crawl/consolidateBatch(existing) resolves
 *        `existing` from digest.topics[match] (Dewey's canonical entry) — the
 *        crawl extends kb-<d>-… instead of spawning a near-duplicate.
 *     2. CURRENCY-AWARE: digest topics carry `currency`; a crawl batch is
 *        archived/snapshot, so when it matches a LIVE topic it ADDS dated history
 *        as context and never overwrites current truth (the archived-vs-live
 *        guard, enforced at the source stage, not just in `contradict`).
 *     3. RUNNING DIGEST: crawl outruns Dewey's sweep timer, so the consumer
 *        merges the published digest with the topics THIS crawl has produced so
 *        far (oldest→newest). Batch N therefore dedups against batches 1..N-1
 *        without waiting for a republish. See `mergeRunningDigest` note below.
 *     4. JOURNEY CONTINUATION: digest.journey carries the current reconstructed
 *        history so CRAWL_JOURNEY extends the narrative instead of restarting it.
 *
 * WHY: raises INPUT quality for the whole KB on both paths. Categorizing with
 * context at the source means Dewey's sweep does less LLM re-work → less variance.
 *
 * BUILD ORDER: implement AFTER the typed Entry + assembler land. Wiring points:
 *   1. kb/librarian: `renderDomainDigest(roots, domain)` — write _digest.json each
 *      sweep (mirror-safe, deterministic), alongside renderDomainIndex.
 *   2a. memory/orchestrator (live): inject the primed subset into the session
 *       consolidation prompt (not wired; see PATH A).
 *   2b. memory/crawl/consolidate (crawl): feed digest.topics[match] as `existing`,
 *       pass `currency`, and maintain the running merge across batches; feed
 *       digest.journey into crawl/journey.
 *   3. prompts.ts CONSOLIDATE_SYSTEM + CRAWL_CONSOLIDATE_SYSTEM: instruct to emit
 *      deltas against known topics, reuse real ids, prefer merge, and (crawl)
 *      layer dated history under live truth.
 *   Knobs live in engine tuning.ts → DIGEST.
 */
import { z } from "zod";

/** One section node in the hierarchical digest tree. */
export type DigestSection = {
  sectionId: string;
  title: string;
  summary: string;
  currency: "live" | "snapshot" | "archived";
  entryIds: string[];
  children: DigestSection[];
};

export const DigestSectionSchema: z.ZodType<DigestSection> = z.lazy(() =>
  z.object({
    sectionId: z.string(),
    title: z.string(),
    summary: z.string(),
    currency: z.enum(["live", "snapshot", "archived"]),
    entryIds: z.array(z.string()),
    children: z.array(DigestSectionSchema),
  })
);

/** A structural-hole / gap the pack wants filled (from the health report, later).
 *  Makes observation PURPOSEFUL: a wolf knows what context is thin. */
export const DigestGapSchema = z.object({
  label: z.string(),
  reason: z.string(),
});
export type DigestGap = z.infer<typeof DigestGapSchema>;

/** The per-domain brief Dewey publishes. Deterministic; regenerated each sweep.
 *  Now a hierarchical section tree projection instead of flat topics. */
export const ContextDigestSchema = z.object({
  domain: z.string(),
  generated: z.string(),
  /** Active controlled vocabulary snapshot, so wolves categorize with the current
   *  taxonomy (kinds/facets/relation kinds) even if config drifts between syncs. */
  vocabulary: z.object({
    kinds: z.array(z.string()),
    facetKeys: z.array(z.string()),
    relationKinds: z.array(z.string()),
  }),
  /** The section tree (hierarchical projection of the KB). */
  sections: z.array(DigestSectionSchema),
  /** Known gaps to steer capture toward (optional until the health loop lands). */
  gaps: z.array(DigestGapSchema).default([]),
  /** Current reconstructed domain history, so CRAWL_JOURNEY extends rather than
   *  restarts the narrative. Omitted for live consolidation. */
  journey: z.string().optional(),
});
export type ContextDigest = z.infer<typeof ContextDigestSchema>;

/**
 * RUNNING DIGEST (crawl only) — the consumer-side merge the crawl maintains so a
 * fast batch run doesn't wait on Dewey's sweep timer:
 *
 *   runningDigest(batchN) = publishedDigest  ⊕  sections produced by batches 1..N-1
 *
 * Implemented in memory/crawl (consumer), not here; this type documents the
 * shape so both ends agree. `mergeRunningDigest(published, produced)` unions
 * sections by sectionId (produced wins — it's fresher within the run).
 */
export type RunningDigest = ContextDigest;
