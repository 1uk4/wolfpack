/**
 * Classification schema — the consolidator's first decision.
 * Given an observation, what kind of thing is it?
 */
import { z } from "zod";

export const ObservationClassificationSchema = z.object({
  type: z.enum(["knowledge", "work_item"]),
  /** If work_item: what action does this observation imply? */
  itemAction: z
    .enum(["create", "update_status", "add_detail", "complete"])
    .optional(),
  /** If work_item: which existing item does this relate to? (id or null for new) */
  itemReference: z.string().nullable().optional(),
  /** Which domain does this belong to? */
  domain: z.string(),
  /** Brief reasoning for the classification */
  reasoning: z.string(),
});

export type ObservationClassification = z.infer<
  typeof ObservationClassificationSchema
>;

/**
 * Batch classification — classify multiple observations at once to reduce
 * LLM calls. Each result maps back to the observation by index.
 */
export const BatchClassificationSchema = z.object({
  classifications: z.array(ObservationClassificationSchema),
});

export type BatchClassification = z.infer<typeof BatchClassificationSchema>;
