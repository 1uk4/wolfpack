/** Hub device pairing (POST /v1/pair): trade a single-use pairing code (from `hubd pair`) for a per-device bearer token. */
import { z } from "zod";

export const TOKEN_KINDS = ["worker", "console", "browser"] as const;
export const TokenKindSchema = z.enum(TOKEN_KINDS);
export type TokenKind = z.infer<typeof TokenKindSchema>;

export const PairRequestSchema = z
  .object({
    code: z.string().min(1).max(128),
    /** Human label of the device (free text). */
    label: z.string().min(1).max(64),
    kind: TokenKindSchema,
    /** The host a worker token belongs to (lower-case letters, digits, hyphens). REQUIRED for kind `worker`; it is that token's actor id. */
    hostId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64).optional(),
  })
  .strict()
  .refine((v) => v.kind !== "worker" || v.hostId !== undefined, { message: "hostId is required for a worker token", path: ["hostId"] });
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({ token: z.string().min(1), tokenId: z.string().min(1) });
export type PairResponse = z.infer<typeof PairResponseSchema>;
