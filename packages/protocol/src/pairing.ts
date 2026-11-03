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

export const PairResponseSchema = z.object({ token: z.string().min(1), tokenId: z.string().min(1), hostId: z.string().optional() });
export type PairResponse = z.infer<typeof PairResponseSchema>;

/**
 * Device management (GET/DELETE /v1/tokens, POST /v1/tokens/pairing-codes). Callers: console and browser tokens only; a worker
 * token gets 403. The list covers console/browser devices (never worker tokens) and never carries a secret or hash.
 */
export const DeviceSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  kind: z.enum(["console", "browser"]),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** True for the device whose token made this request. */
  self: z.boolean(),
  /** Label of the device that minted this one's pairing code; null when minted on the host CLI (or the minter is gone / predates provenance). */
  addedBy: z.string().nullable(),
  /** Id of that minting device (kept even if it was revoked since), null when unknown. */
  addedById: z.string().nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;
export const DeviceListSchema = z.object({ devices: z.array(DeviceSchema) });
export type DeviceList = z.infer<typeof DeviceListSchema>;
/** `revoked`: the id asked for; `cascaded`: the other devices revoked with it (`?cascade=1`); `self`: the caller's own token was among them. */
export const RevokeDeviceResponseSchema = z.object({ revoked: z.string(), self: z.boolean(), cascaded: z.array(z.string()).default([]) });
export const MintPairingCodeRequestSchema = z.object({ label: z.string().max(64).optional() }).strict();
export const MintPairingCodeResponseSchema = z.object({ code: z.string().min(1), expiresAt: z.string() });
export type MintPairingCodeResponse = z.infer<typeof MintPairingCodeResponseSchema>;
