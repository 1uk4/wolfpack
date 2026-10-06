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

/** classifyEntry — only fires for an unroutable singleton with a weak hint. */
export const ClassifyResultSchema = z.object({
  domain: z.string(),
  type: z.enum(["fact", "decision", "process", "reference"]),
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
