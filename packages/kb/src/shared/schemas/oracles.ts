/**
 * Oracle schemas — the three narrow, mostly-conditional LLM calls.
 * Everything else in the sweep is deterministic code.
 */
import { z } from "zod";
import { EntryTypeSchema } from "@wolfpack/engine";

/** contradict — only fires on high similarity + content diff. */
export const ContradictResultSchema = z.object({
  conflicts: z.boolean(),
  winner: z.enum(["new", "existing", "unclear"]),
  reason: z.string(),
});
export type ContradictResult = z.infer<typeof ContradictResultSchema>;

/** classifyEntry — only fires for an unroutable singleton with a weak hint. */
export const ClassifyResultSchema = z.object({
  domain: z.string(),
  // Unified with the entry schema's controlled vocabulary (single source of truth).
  type: EntryTypeSchema,
  /** Set when type='other' (or to refine the type): preferred kebab-case word. */
  tag: z.string().optional(),
  subcategory: z.string(),
  reasoning: z.string(),
});
export type ClassifyResult = z.infer<typeof ClassifyResultSchema>;

/** labelTopic — only at crystallization, and deferrable. */
export const LabelTopicResultSchema = z.object({
  label: z.string(),
  slug: z.string(),
  reasoning: z.string(),
});
export type LabelTopicResult = z.infer<typeof LabelTopicResultSchema>;

/** sectionPick — route a contribution to ONE section or NEW. */
export const SectionPickSchema = z.object({
  /** A provided section id from the digest enum, or the literal string "NEW". */
  section: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});
export type SectionPick = z.infer<typeof SectionPickSchema>;

/** sectionSummary — summarize a bounded set of child summaries. */
export const SectionSummarySchema = z.object({
  /** One paragraph describing what the section is about. */
  summary: z.string(),
});
export type SectionSummary = z.infer<typeof SectionSummarySchema>;

export const LabelSectionSchema = z.object({
  /** A short, specific section title (2–6 words). */
  title: z.string(),
});
export type LabelSection = z.infer<typeof LabelSectionSchema>;
