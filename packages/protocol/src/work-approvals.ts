/** Owner-approval requests for graduate, archive and reassign (hubd). A worker token files a request; only a non-worker token decides it. */
import { z } from "zod";
import { GraduationContributionSchema } from "./schemas.js";

export const APPROVAL_KINDS = ["graduate", "archive", "reassign"] as const;
export const ApprovalKindSchema = z.enum(APPROVAL_KINDS);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;
export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);

/** The set a graduate approval sends: the distilled contributions the owner saw in the preview. */
export const ApprovalPreviewSchema = z.object({ contributions: z.array(GraduationContributionSchema) }).passthrough();

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  workId: z.string(),
  kind: ApprovalKindSchema,
  requestedBy: z.object({ wolf: z.string(), thread: z.string().optional() }),
  requestedAt: z.iso.datetime({ offset: true }),
  /** graduate: the stored distilled contribution set; null for archive and reassign. */
  preview: ApprovalPreviewSchema.nullable(),
  /** reassign: the new assignee; null otherwise. */
  target: z.string().nullable(),
  status: ApprovalStatusSchema,
  decidedAt: z.iso.datetime({ offset: true }).optional(),
  decidedBy: z.object({ device: z.string(), actor: z.string() }).optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** `POST /v1/work/:id/requests`. `preview` is required for graduate; `target` for reassign. 409 `request_pending` (details.requestId) when one is already pending for the item. */
export const CreateApprovalRequestBodySchema = z.object({
  kind: ApprovalKindSchema,
  wolf: z.string().min(1).optional(),
  thread: z.string().optional(),
  preview: ApprovalPreviewSchema.nullable().optional(),
  target: z.string().min(1).nullable().optional(),
});
export type CreateApprovalRequestBody = z.infer<typeof CreateApprovalRequestBodySchema>;

export const ApprovalResponseSchema = z.object({ request: ApprovalRequestSchema });
export const ApprovalListResponseSchema = z.object({ requests: z.array(ApprovalRequestSchema) });

/** The structured line an approval appends to the feature Record (written before the action, so an archive still finds the Record open). */
export const ApprovalAuditLineSchema = z.object({
  requestId: z.string(),
  kind: ApprovalKindSchema,
  actor: z.string(),
  device: z.string(),
  at: z.iso.datetime({ offset: true }),
  /** "sent: 3 contributions" | "stage archived" | "assignee <wolf>" */
  outcome: z.string(),
});
export type ApprovalAuditLine = z.infer<typeof ApprovalAuditLineSchema>;
