/**
 * Oracle schemas — the three narrow, mostly-conditional LLM calls.
 * Everything else in the sweep is deterministic code.
 */
import { z } from "zod";

/** contradict — only fires on high similarity + content diff. */
export const ContradictResultSchema = z.object({
  conflicts: z.boolean(),
  winner: z.enum(["new", "existing", "unclear"]),
  reason: z.string(),
});
export type ContradictResult = z.infer<typeof ContradictResultSchema>;

/** sectionPick — route a contribution to ONE section or NEW. */
export const SectionPickSchema = z.object({
  /** A provided section id from the digest enum, or the literal string "NEW". */
  section: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});
export type SectionPick = z.infer<typeof SectionPickSchema>;

/** sectionSummary — summarize a bounded set of child summaries. */
export const SectionSummarySchema = z.object({
  /** One line (≤140 chars) naming what the section's entries are about.
   *  Clipped rather than rejected, like entry and topic summaries. */
  summary: z
    .string()
    .transform((s) => s.trim())
    .transform((s) => (s.length > 140 ? s.slice(0, 139) + "…" : s)),
});
export type SectionSummary = z.infer<typeof SectionSummarySchema>;

export const LabelSectionSchema = z.object({
  /** A short, specific section title (2–6 words). */
  title: z.string(),
});
export type LabelSection = z.infer<typeof LabelSectionSchema>;
