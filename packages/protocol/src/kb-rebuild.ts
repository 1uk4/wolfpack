/** Hub KB section rebuild (operator-only): preview writes a plan file, apply commits exactly that plan, restore undoes an apply. */
import { z } from "zod";

export const RebuildFlagsSchema = z.object({
  from: z.enum(["current", "scratch"]).default("current"),
  applyCrossMoves: z.boolean().default(false),
  approvedCrossMoves: z.array(z.string().min(1)).default([]),
  allowCollapse: z.boolean().default(false),
  allowKmeansFallback: z.boolean().default(false),
}).strict();
export type RebuildFlags = z.infer<typeof RebuildFlagsSchema>;

export const RebuildPreviewRequestSchema = z.object({ domain: z.string().min(1), flags: RebuildFlagsSchema.default(() => RebuildFlagsSchema.parse({})) }).strict();
export const RebuildPreviewResponseSchema = z.object({ jobId: z.string(), status: z.literal("started") }).strict();

/** `expectFlags`, when given, must equal the plan's flags exactly (409 `conflict` otherwise). */
export const RebuildApplyRequestSchema = z.object({ planId: z.string().min(1), expectFlags: RebuildFlagsSchema.optional() }).strict();
export const RebuildApplyResponseSchema = z.object({
  planId: z.string(), domain: z.string(), stamp: z.string(), entriesWritten: z.number().int(), sections: z.number().int(), backupDir: z.string(),
  /** `missing` when some entry had no cached embedding at apply time: those sections carry no centroid until the next bootstrap/reorg. */
  centroids: z.enum(["set", "missing"]), centroidsMissing: z.number().int(),
}).strict();

export const RebuildRestoreRequestSchema = z.object({ domain: z.string().min(1), stamp: z.string().min(1) }).strict();
export const RebuildRestoreResponseSchema = z.object({ domain: z.string(), stamp: z.string(), entriesRestored: z.number().int(), sections: z.number().int() }).strict();

export const RebuildListResponseSchema = z.object({
  plans: z.array(z.object({ planId: z.string(), domain: z.string(), createdAt: z.string(), sections: z.number().int(), entries: z.number().int(), flags: RebuildFlagsSchema })),
  jobs: z.array(z.object({ jobId: z.string(), domain: z.string(), state: z.enum(["running", "done", "failed"]), startedAt: z.string(), planId: z.string().optional(), error: z.string().optional() })),
  /** Restore points (stamps) the hub holds, newest last. */
  backups: z.array(z.string()),
}).strict();
export type RebuildListResponse = z.infer<typeof RebuildListResponseSchema>;
