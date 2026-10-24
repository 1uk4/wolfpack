/**
 * Contribution — the delta a wolf emits during /wolf:promote.
 *
 * Deterministic to produce (NO LLM on the wolf side). Replaces the old
 * per-topic `claimCheck` scout: the wolf reports *what changed* about a den
 * topic; Dewey decides whether/where it lands in the KB.
 */
import { z } from "zod";

/** What an anchor key may look like (it is written to frontmatter). */
export const ANCHOR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
  /**
   * Anchored subject: a stable key for the entry this contribution belongs to
   * (graduation's initiative contribution: `work-<domain>-<initiativeId>`).
   * Routed by key alone, never by similarity or the subject check.
   */
  anchor: z.string().optional(),
  /**
   * Verbatim: the body is the entry as authored. The librarian stores it
   * as-is (no rewrite, no lint, no size pass). Only meaningful with `anchor`.
   */
  verbatim: z.boolean().optional(),
  /**
   * Group key (an anchor key): this entry belongs under the anchored entry
   * holding that key, shown and sectioned with it, ordered by `groupDate`.
   */
  group: z.string().regex(ANCHOR_RE).optional(),
  /** Ordering date within the group (YYYY-MM-DD). */
  groupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /**
   * Hint from distill: the existing entry this contribution is about. A strong
   * prior for the sweep's subject check, never a bypass of it.
   */
  target: z.string().optional(),
});

export type Contribution = z.infer<typeof ContributionSchema>;

/** A contribution after intake parsing — carries its source file path. */
export interface ParsedContribution extends Contribution {
  filePath: string;
}
