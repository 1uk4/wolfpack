/**
 * Live Item schema — a tracked work item that moves through stages.
 * Plans, features, bugs, tasks — anything with a lifecycle.
 */
import { z } from "zod";

export const ItemStatusSchema = z.enum([
  "planning",
  "active",
  "blocked",
  "paused",
  "done",
  "cancelled",
]);

export const LiveItemSchema = z.object({
  id: z.string().describe("Stable unique identifier"),
  title: z.string(),
  status: ItemStatusSchema,
  domain: z.string(),
  summary: z.string().describe("Current state in one paragraph"),
  plan: z.string().optional().describe("The approach or plan, if defined"),
  blockers: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]).describe("IDs of other items"),
  related: z
    .array(z.string())
    .default([])
    .describe("IDs of related entries or items — the link graph"),
  created: z.string(),
  updated: z.string(),
});

export type LiveItem = z.infer<typeof LiveItemSchema>;

/**
 * Item update — structured output from the consolidator when
 * an observation references a work item.
 */
export const ItemUpdateSchema = z.object({
  action: z.enum(["create", "update_status", "add_detail", "complete"]),
  itemId: z.string().nullable().describe("Existing item ID, or null to create"),
  title: z.string().optional().describe("Required if creating"),
  status: ItemStatusSchema.optional(),
  detailToAdd: z.string().optional(),
  newRelated: z.array(z.string()).default([]),
  reasoning: z.string(),
});

export type ItemUpdate = z.infer<typeof ItemUpdateSchema>;
