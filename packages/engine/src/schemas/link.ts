/**
 * Link schema — connections between entries in the knowledge graph.
 * Used by the consolidator to maintain the link graph after writes.
 */
import { z } from "zod";

export const RelationshipTypeSchema = z.enum([
  "related",       // general relevance
  "implements",    // this entry implements that plan/decision
  "depends_on",    // this entry requires that entry
  "contradicts",   // this entry conflicts with that entry
  "extends",       // this entry adds to that entry
  "caused_by",     // this entry was caused by that event
  "part_of",       // this entry is a component of that system/feature
  "supersedes",    // this entry replaces that entry
]);

export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const LinkSchema = z.object({
  targetId: z.string(),
  relationship: RelationshipTypeSchema,
});

export type Link = z.infer<typeof LinkSchema>;

/**
 * Link assessment — the consolidator's output when linking a new/updated
 * entry to existing entries. One LLM call with Zod output.
 */
export const LinkAssessmentSchema = z.object({
  links: z.array(LinkSchema),
  reasoning: z.string(),
});

export type LinkAssessment = z.infer<typeof LinkAssessmentSchema>;
