/**
 * Feed notice — Dewey → wolf. Pointer + summary only (lean dens); the wolf
 * resolves the full entry on demand against its local kb-base mirror.
 */
import { z } from "zod";

export const FeedNoticeSchema = z.object({
  canonicalId: z.string(),
  entryId: z.string(),
  /** The receiving wolf's local name for this topic, if it has one. */
  yourAlias: z.string().nullable(),
  change: z.enum(["created", "updated", "superseded"]),
  /** Which wolf's contribution caused the change. */
  by: z.string(),
  summary: z.string(),
  updated: z.string(),
});

export type FeedNotice = z.infer<typeof FeedNoticeSchema>;
