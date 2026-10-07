/**
 * Crawl schemas — the deterministic front-end's typed boundaries.
 *
 * A crawl reproduces the memory pipeline across time (see docs/crawl-spec.md):
 * deterministic code decides WHICH documents, in WHAT chronological order, and
 * recovers each document's DATE; the LLM pipeline (observe → consolidate →
 * journey) is the template, unchanged. These schemas cover only the front-end.
 */
import { z } from "zod";

// ── Dates: the ordering substrate ───────────────────────────────────────────

/** How a document's date was recovered, and how much to trust it for ordering. */
export const DateInfoSchema = z.object({
  /** ISO "YYYY-MM-DD", or a coarser "YYYY-MM" / "YYYY" when that's all we know. */
  date: z.string().optional(),
  basis: z.enum(["frontmatter", "git", "filename", "content", "mtime", "none"]),
  /** high/medium order reliably; low (mtime) never orders; none = undated. */
  confidence: z.enum(["high", "medium", "low", "none"]),
});
export type DateInfo = z.infer<typeof DateInfoSchema>;

// ── Discovery ───────────────────────────────────────────────────────────────

export interface SourceFile {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to the crawl source root (stable id material). */
  relPath: string;
  /** File size in bytes. */
  bytes: number;
}

/** A discovered file plus its resolved date — the unit `group.ts` batches over. */
export interface DatedFile extends SourceFile {
  dateInfo: DateInfo;
}

// ── Plan ────────────────────────────────────────────────────────────────────

export const CurrencySchema = z.enum(["live", "snapshot", "archived"]);
export type Currency = z.infer<typeof CurrencySchema>;

export const BatchSchema = z.object({
  /** Topic slug — the pre-declared consolidation scope (= den_topic_id stem). */
  topic: z.string().min(1),
  /** Globs (relative to source) selecting this batch's files. */
  files: z.array(z.string().min(1)).min(1),
  /** Per-batch currency override (else the plan default). */
  currency: CurrencySchema.optional(),
  /** Human-pinned date/range (plan mode). Becomes a high-confidence source. */
  date: z.string().optional(),
});
export type Batch = z.infer<typeof BatchSchema>;

export const CrawlPlanSchema = z.object({
  /** Declared KB domain these contributions target. */
  domain: z.string().min(1),
  /** Absolute (or ~) source root. */
  source: z.string().min(1),
  /** Whole-crawl currency default. */
  currency: CurrencySchema.default("archived"),
  /** draft = still editing; ready = the run gate will accept it. */
  status: z.enum(["draft", "ready"]).default("draft"),
  /** Extra excludes on top of the defaults. */
  exclude: z.array(z.string()).default([]),
  /** Include globs (default ["**\/*.md"]). */
  include: z.array(z.string()).default([]),
  batches: z.array(BatchSchema).min(1),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
});
export type CrawlPlan = z.infer<typeof CrawlPlanSchema>;

// ── Strategy ────────────────────────────────────────────────────────────────

export const StrategySchema = z.enum(["by-folder", "by-pattern", "by-manifest"]);
export type Strategy = z.infer<typeof StrategySchema>;
