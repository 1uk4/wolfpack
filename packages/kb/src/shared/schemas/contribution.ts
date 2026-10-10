/**
 * Contribution — the delta a wolf emits during /wolf:promote.
 *
 * Deterministic to produce (NO LLM on the wolf side). Replaces the old
 * per-topic `claimCheck` scout: the wolf reports *what changed* about a den
 * topic; Dewey decides whether/where it lands in the KB.
 */
import { z } from "zod";

export const ContributionSchema = z.object({
  /** Which wolf produced this (provenance). */
  from: z.string(),
  /** Which machine — optional provenance. */
  host: z.string().optional(),
  /** The wolf's LOCAL den topic id — the join key into the registry. */
  denTopicId: z.string(),
  /** Consolidation outcome that produced this delta. */
  change: z.enum(["create", "merge"]),
  /** sha256 of the topic body — idempotency + dedup. */
  contentHash: z.string(),
  /** Previous hash (null on first contribution for this topic). */
  prevHash: z.string().nullable(),
  /** Where the wolf thinks this belongs. */
  domainHint: z.string(),
  /** The den topic's own summary line. */
  summary: z.string(),
  /** Pi session id, for auditing. */
  session: z.string().optional(),
  /** ISO-ish timestamp "YYYY-MM-DD HH:MM". */
  submitted: z.string(),
  /** The den topic body (the knowledge itself). */
  body: z.string(),

  // ── Temporal provenance (crawl / historical ingestion) ──────────────────
  // All optional: live wolf promotions omit them and are unaffected. They let
  // Dewey judge recency by fact and treat archived history as append-only.
  /** Earliest source date folded into this contribution (ISO). */
  sourceCreated: z.string().optional(),
  /** Latest source date folded into this contribution (ISO). */
  sourceUpdated: z.string().optional(),
  /** How the source date was recovered (trust basis). */
  dateBasis: z
    .enum(["frontmatter", "git", "filename", "content", "mtime", "none"])
    .optional(),
  /** Confidence in the source date. */
  dateConfidence: z.enum(["high", "medium", "low", "none"]).optional(),
  /** Whether this is current, a point-in-time snapshot, or historical. */
  currency: z.enum(["live", "snapshot", "archived"]).optional(),
  /** Originating source path (provenance). */
  sourcePath: z.string().optional(),
  /**
   * How this contribution was produced:
   *   "wolf"  — a wolf's lived/promoted memory (default).
   *   "crawl" — bulk-ingested from a document corpus (the wolf acted as a SCRIBE).
   * Dewey uses this to distinguish curated lived knowledge from ingested history;
   * combined with `currency`, a crawl is historical reference, not lived truth.
   */
  origin: z.enum(["wolf", "crawl"]).optional(),

  // ── Graduation (finished Factory work → past-tense knowledge) ───────────
  /** Set when this contribution is graduated work: a feature, or an
   *  initiative's hub. The sweep writes it with the graduation prompt. */
  graduation: z.enum(["feature", "hub"]).optional(),
  /** The entry this graduation owns (created first time, updated after).
   *  Named by the sender, so the KB never interprets work ids. */
  entryId: z.string().optional(),
  /** Hub only: the initiative is complete (adds an outcome summary). */
  final: z.boolean().optional(),
  /** Feature only: the hub entry it belongs to (its initiative's), linked
   *  part_of by code. Named by the sender, like entryId. */
  partOf: z.string().optional(),
});

export type Contribution = z.infer<typeof ContributionSchema>;

/** A contribution after intake parsing — carries its source file path. */
export interface ParsedContribution extends Contribution {
  filePath: string;
}
