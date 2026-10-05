/**
 * Assessment schema — the Librarian's judgment on a claim.
 * This is the core LLM decision: what do we do with this claim?
 */
import { z } from "zod";

export const AssessmentActionSchema = z.enum([
  "create",
  "merge",
  "supersede",
  "reject",
]);

export const AssessmentSchema = z.object({
  action: AssessmentActionSchema,
  reasoning: z.string().describe("Why this action was chosen"),
  confidence: z.enum(["low", "medium", "high", "verified"]),
  type: z.string().describe("Entry type: fact, decision, bug, etc."),
  subcategory: z.string().optional(),
  /** If merge: which entry to merge into */
  mergeTarget: z.string().nullable().optional(),
  /** If supersede: which entry to replace */
  supersedeTarget: z.string().nullable().optional(),
  /** If reject: why */
  rejectReason: z.string().optional(),
  /** Related entries to link to */
  relatedEntries: z.array(z.string()).default([]),
});

export type Assessment = z.infer<typeof AssessmentSchema>;
