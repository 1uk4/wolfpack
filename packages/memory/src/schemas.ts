/**
 * Schemas specific to the wolf consolidator's LLM outputs.
 */
import { z } from "zod";

/**
 * A single merge/create/skip decision for one session topic.
 */
export const TopicActionSchema = z.object({
  sessionTopicId: z.string().describe("The session topic being processed"),
  action: z.enum(["merge", "create", "skip"]),
  /** If merge: which den topic to merge into */
  mergeTargetId: z.string().nullable().optional(),
  /** The resulting topic content (for merge and create; null/absent for skip) */
  result: z
    .object({
      id: z.string().describe("Topic ID (slug, kebab-case)"),
      title: z.string(),
      // Soft limit: clip rather than reject, so a slightly-long summary never
      // fails (and retries) an expensive consolidation.
      summary: z
        .string()
        .describe("One line (\u2264140 chars), what this topic covers — shown in the index")
        .transform((s) => (s.length > 140 ? s.slice(0, 139) + "\u2026" : s)),
      body: z.string().describe("Full topic content, current-state prose"),
    })
    .nullable()
    .optional(),
  reasoning: z.string(),
});

export type TopicAction = z.infer<typeof TopicActionSchema>;

/**
 * The full consolidation result — one decision per session topic.
 */
export const ConsolidationResultSchema = z.object({
  actions: z.array(TopicActionSchema),
});

export type ConsolidationResult = z.infer<typeof ConsolidationResultSchema>;
