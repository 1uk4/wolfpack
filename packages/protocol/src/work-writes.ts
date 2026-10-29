/** Hub-scoped work WRITE bodies and responses (hubd). Ported from the agent Work API; see ROUTES.hubCreateWork etc. */
import { z } from "zod";

export const WORK_KINDS = ["initiative", "feature", "task", "issue", "spike", "idea"] as const;

/** The item as the write routes return it: the folded ledger state (extra fields pass through). */
export const WorkWriteItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: z.string(),
    stage: z.string(),
    domain: z.string(),
    assignee: z.string().optional(),
    partOf: z.string().nullable().optional(),
  })
  .passthrough();
export type WorkWriteItem = z.infer<typeof WorkWriteItemSchema>;

export const CreateWorkRequestSchema = z.object({
  kind: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),
  assignee: z.string().min(1),
  area: z.string().nullable().optional(),
  partOf: z.string().nullable().optional(),
  successCriteria: z.string().nullable().optional(),
  stage: z.string().optional(),
  standing: z.boolean().optional(),
});
export type CreateWorkRequest = z.infer<typeof CreateWorkRequestSchema>;
export const CreateWorkResponseSchema = z.object({ id: z.string(), item: WorkWriteItemSchema });
export type CreateWorkResponse = z.infer<typeof CreateWorkResponseSchema>;

const RelTarget = z.object({ rel: z.string(), target: z.string() });
/**
 * `PATCH /v1/work/:id`: exactly ONE field per request for now (the agent Work API's semantics). `body` and `assignee` are
 * operator-only. `moveTo: null` un-parents.
 */
export const PatchWorkRequestSchema = z.object({
  stage: z.string().optional(),
  note: z.string().optional(),
  title: z.string().optional(),
  successCriteria: z.string().optional(),
  assignee: z.string().optional(),
  moveTo: z.string().nullable().optional(),
  link: RelTarget.optional(),
  unlink: RelTarget.optional(),
  body: z.string().optional(),
  standing: z.boolean().optional(),
  schedule: z.object({ scheduledFor: z.string().nullable(), durationMinutes: z.number().nullable().optional() }).optional(),
});
export type PatchWorkRequest = z.infer<typeof PatchWorkRequestSchema>;
export const WorkItemResponseSchema = z.object({ item: WorkWriteItemSchema });
export type WorkItemResponse = z.infer<typeof WorkItemResponseSchema>;

export const DeleteWorkResponseSchema = z.object({ deleted: z.array(z.string()) });
export type DeleteWorkResponse = z.infer<typeof DeleteWorkResponseSchema>;
