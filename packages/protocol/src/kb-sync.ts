/** Hub KB sync reads (revisions, change log, manifest, manifest diff). Read-only; writers use KB commits. */
import { z } from "zod";

/** Paths the hub versions and serves, relative to `kb/base/domains/<domain>/`. Wider than KB_COMMIT_PATH: also entry history. */
export const KB_SYNC_PATH = /^(entries\/[A-Za-z0-9._~-]+\.md|versions\/[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+\.md|_registry\.md|_digest\.json|INDEX\.md)$/;
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const path = z.string().regex(KB_SYNC_PATH);

export const KbSyncFileSchema = z.object({ path, contentHash: hash, encoding: z.literal("utf8"), content: z.string() });
export type KbSyncFile = z.infer<typeof KbSyncFileSchema>;

const resetReason = z.enum(["below_floor", "epoch_mismatch", "ahead_of_hub"]);

export const KbChangesResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    domain: z.string(),
    epoch: z.string(),
    since: z.number().int(),
    /** Revision the client has after applying this response (== hub head unless `truncated`). */
    revision: z.number().int(),
    /** True when maxBytes cut the page short; ask again with since=revision. */
    truncated: z.boolean(),
    files: z.array(KbSyncFileSchema),
    deletes: z.array(z.object({ path })),
  }),
  z.object({ status: z.literal("reset"), domain: z.string(), epoch: z.string(), reason: resetReason, floor: z.number().int(), revision: z.number().int() }),
]);
export type KbChangesResponse = z.infer<typeof KbChangesResponseSchema>;

export const KbManifestResponseSchema = z.object({ domain: z.string(), epoch: z.string(), revision: z.number().int(), floor: z.number().int(), files: z.record(path, hash) });
export type KbManifestResponse = z.infer<typeof KbManifestResponseSchema>;

export const KbManifestDiffRequestSchema = z.object({ files: z.record(z.string(), hash), maxBytes: z.number().int().positive().optional() }).strict();
export type KbManifestDiffRequest = z.infer<typeof KbManifestDiffRequestSchema>;

export const KbManifestDiffResponseSchema = z.object({
  domain: z.string(),
  epoch: z.string(),
  /** Hub revision the manifest was read at; adopt it as the new `since` once `pending` is empty. */
  revision: z.number().int(),
  files: z.array(KbSyncFileSchema),
  deletes: z.array(z.object({ path: z.string() })),
  /** Paths still to fetch (differing/missing files that did not fit maxBytes); call again with the updated manifest. */
  pending: z.array(path),
});
export type KbManifestDiffResponse = z.infer<typeof KbManifestDiffResponseSchema>;
