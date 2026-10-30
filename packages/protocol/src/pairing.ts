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
    /** Optional: the kind is FIXED by the code (`hubd pair --kind`). If given it must match, else 401. */
    kind: TokenKindSchema.optional(),
    /** Optional: the host is FIXED by the code (`hubd pair --host-id`, worker codes only). If given it must match, else 401. */
    hostId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64).optional(),
  })
  .strict();
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({ token: z.string().min(1), tokenId: z.string().min(1) });
export type PairResponse = z.infer<typeof PairResponseSchema>;
