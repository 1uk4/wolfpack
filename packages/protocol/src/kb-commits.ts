/** Hub KB commit bodies (POST /v1/kb/commits). Only the curator (system, in-process) and the operator may commit. */
import { z } from "zod";

/** Path of a committable file, relative to `kb/base/domains/<domain>/`. Nothing else is accepted. */
export const KB_COMMIT_PATH = /^(entries\/[A-Za-z0-9._~-]+\.md|_registry\.md|_digest\.json|INDEX\.md)$/;
/** `sha256:<64 hex>` (contentHash of the file's UTF-8 text). */
export const KB_HASH = /^sha256:[0-9a-f]{64}$/;
/** Request body cap of the route, bytes (a batch carries whole files). */
export const KB_COMMIT_BODY_LIMIT = 8 * 1024 * 1024;

const common = { domain: z.string().min(1), path: z.string().regex(KB_COMMIT_PATH, "path must be entries/<id>.md, _registry.md, _digest.json or INDEX.md") };
const hash = z.string().regex(KB_HASH);

/**
 * create: prevHash null (the file must not exist). update: prevHash = hash of the current file. delete: prevHash = hash of the
 * current file, contentHash null, no content. contentHash must equal sha256 of `content`.
 */
export const KbChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), ...common, content: z.string(), contentHash: hash, prevHash: z.null() }).strict(),
  z.object({ op: z.literal("update"), ...common, content: z.string(), contentHash: hash, prevHash: hash }).strict(),
  z.object({ op: z.literal("delete"), ...common, contentHash: z.null(), prevHash: hash }).strict(),
]);
export type KbChange = z.infer<typeof KbChangeSchema>;

export const KbCommitRequestSchema = z.object({ changes: z.array(KbChangeSchema).min(1).max(500) }).strict();
export type KbCommitRequest = z.infer<typeof KbCommitRequestSchema>;

export const KbCommitResponseSchema = z.object({
  committed: z.number().int(),
  /** Entry ids touched (entries/*.md changes), across domains. */
  entryIds: z.array(z.string()),
  domains: z.array(z.string()),
  files: z.array(z.object({ domain: z.string(), path: z.string(), op: z.enum(["create", "update", "delete"]), contentHash: z.string().nullable() })),
});
export type KbCommitResponse = z.infer<typeof KbCommitResponseSchema>;
