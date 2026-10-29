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
  kind: z.enum(WORK_KINDS),
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
 * `PATCH /v1/work/:id`. Either one op (exactly one field) or a batch `{ops:[...]}` of single-field ops. Deliberate behaviours: STRICT
 * (an unknown key is `invalid_request`); EXACTLY ONE field per op;
 * `stage` / `note` / `title` / `assignee` must be non-empty; `moveTo` is a non-empty id, or `null` to un-parent (the hierarchy
 * rules still apply: only an item that may stand alone, e.g. a feature, can be un-parented); `successCriteria: ""` clears the
 * criteria. `body` and `assignee` are operator-only (provisional).
 */
export const PatchWorkOpSchema = z
  .object({
    stage: z.string().optional(),
    note: z.string().optional(),
    title: z.string().optional(),
    successCriteria: z.string().optional(),
    assignee: z.string().optional(),
    moveTo: z.string().min(1).nullable().optional(),
    link: RelTarget.optional(),
    unlink: RelTarget.optional(),
    body: z.string().optional(),
    standing: z.boolean().optional(),
    schedule: z.object({ scheduledFor: z.string().nullable(), durationMinutes: z.number().nullable().optional() }).optional(),
    /** Replace the `plan` or `notes` section of the body. Any other name (e.g. the generated `record`/`log`) is `invalid_request`. */
    section: z.object({ name: z.string(), text: z.string() }).strict().optional(),
  })
  .strict();
export type PatchWorkOp = z.infer<typeof PatchWorkOpSchema>;
export const PATCH_BATCH_MAX = 50;
/** Batch form: `{ ops: [PatchWorkOp, ...] }`; all-or-nothing, applied in order under one lock, nothing appended if any op fails. */
export const PatchWorkBatchSchema = z.object({ ops: z.array(PatchWorkOpSchema).min(1).max(PATCH_BATCH_MAX) }).strict();
export const PatchWorkRequestSchema = z.union([PatchWorkBatchSchema, PatchWorkOpSchema]);
export type PatchWorkRequest = z.infer<typeof PatchWorkRequestSchema>;
export const WorkItemResponseSchema = z.object({ item: WorkWriteItemSchema });
export type WorkItemResponse = z.infer<typeof WorkItemResponseSchema>;

export const DeleteWorkResponseSchema = z.object({ deleted: z.array(z.string()) });
export type DeleteWorkResponse = z.infer<typeof DeleteWorkResponseSchema>;
