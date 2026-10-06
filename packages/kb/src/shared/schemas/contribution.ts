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
});

export type Contribution = z.infer<typeof ContributionSchema>;

/** A contribution after intake parsing — carries its source file path. */
export interface ParsedContribution extends Contribution {
  filePath: string;
}
