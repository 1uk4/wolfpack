/**
 * Hub <-> workerd link frames (one WebSocket per host, GET /v1/link). JSON text frames discriminated on `t`.
 * LINK_PROTOCOL_VERSION is separate from the HTTP PROTOCOL_VERSION; a MAJOR mismatch is rejected (close 4001).
 * Relay frames (req/res/chunk/end/cancel/rerr) are defined here for the relay ticket; nothing handles them yet.
 * Request ids are prefixed by the side that opened them: `h-` (hub) or `w-` (worker).
 */
import { z } from "zod";

export const LINK_PROTOCOL_VERSION = 1;
export const LINK_PATH = "/v1/link";
/** Max frame size once the hello is accepted (before that: LINK_HELLO_MAX_PAYLOAD). */
export const LINK_MAX_PAYLOAD = 8 * 1024 * 1024;
export const LINK_HELLO_TIMEOUT_MS = 10_000;
export const LINK_HEARTBEAT_MS = 10_000;
export const LINK_DEAD_AFTER_MS = 30_000;

/** Until the hello is accepted the hub accepts only small frames. */
export const LINK_HELLO_MAX_PAYLOAD = 64 * 1024;
export const LINK_MAX_WOLVES = 256;
export const LINK_MAX_DOMAINS = 64;
/** An asleep host that has not come back after this long is shown offline. */
export const LINK_ASLEEP_OFFLINE_MS = 12 * 60 * 60 * 1000;

export const LINK_CLOSE = {
  incompatible: 4001,
  noHello: 4400,
  unauthorized: 4401,
  replaced: 4409,
} as const;

const Id = z.string().min(1).max(64);
const Revisions = z.record(z.string(), z.number().int().nonnegative());

export const LinkWolfSchema = z.object({ name: z.string().min(1).max(64), domains: z.array(z.string().min(1).max(64)).max(LINK_MAX_DOMAINS).default([]) });
export type LinkWolf = z.infer<typeof LinkWolfSchema>;

export const LinkErrorCodeSchema = z.enum(["version_mismatch", "unauthorized", "bad_frame", "replaced", "rejected", "internal"]);
export type LinkErrorCode = z.infer<typeof LinkErrorCodeSchema>;

export const LinkHelloSchema = z.object({
  t: z.literal("hello"),
  v: z.number().int().nonnegative(),
  hostId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64),
  laptop: z.boolean(),
  wolves: z.array(LinkWolfSchema).max(LINK_MAX_WOLVES),
  /** Per-domain KB cursors the worker has applied. */
  kbRevisions: Revisions.default({}),
});
export const LinkWelcomeSchema = z.object({
  t: z.literal("welcome"),
  v: z.number().int().nonnegative(),
  heartbeatMs: z.number().int().positive(),
  deadAfterMs: z.number().int().positive(),
  /** Wolves the hub has retired; the worker must not serve them. */
  retired: z.array(z.string()).default([]),
  /** Wolves the hub refused to register for this host (unknown name, or owned by another host). Operator action needed. */
  rejected: z.array(z.string()).default([]),
  /** Informational: wolves whose self-reported domains differ from what the registry grants. The registry decides; the worker never writes domains. */
  domainMismatch: z.array(z.object({ wolf: z.string(), reported: z.array(z.string()), granted: z.array(z.string()) })).default([]),
  hubRevisions: Revisions.default({}),
});
export const LinkWolfAddSchema = z.object({ t: z.literal("wolf.add"), wolf: LinkWolfSchema });
export const LinkWolfRemoveSchema = z.object({ t: z.literal("wolf.remove"), name: z.string().min(1).max(64) });
export const LinkPingSchema = z.object({ t: z.literal("ping"), n: z.number().int() });
export const LinkPongSchema = z.object({ t: z.literal("pong"), n: z.number().int() });
export const LinkSleepSchema = z.object({ t: z.literal("sleep") });
export const LinkByeSchema = z.object({ t: z.literal("bye") });
export const LinkErrorSchema = z.object({ t: z.literal("error"), code: LinkErrorCodeSchema, message: z.string().optional() });

// Relay frames (reserved; no handlers yet).
export const LinkReqSchema = z.object({
  t: z.literal("req"),
  id: Id,
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  wolf: z.string().optional(),
});
export const LinkResSchema = z.object({ t: z.literal("res"), id: Id, status: z.number().int(), headers: z.record(z.string(), z.string()).default({}) });
export const LinkChunkSchema = z.object({ t: z.literal("chunk"), id: Id, data: z.string(), seq: z.number().int().nonnegative() });
export const LinkEndSchema = z.object({ t: z.literal("end"), id: Id });
export const LinkCancelSchema = z.object({ t: z.literal("cancel"), id: Id });
export const LinkRerrSchema = z.object({ t: z.literal("rerr"), id: Id, code: z.string().min(1), message: z.string().optional() });

// Contribution + receipt frames (additive; LINK_PROTOCOL_VERSION unchanged).
// worker -> hub  contribute      one outbox item. `id` is the idempotency id (stable across retries; the hub dedups on hostId+id, persisted).
//                                `wolf` must be owned by the sending host (registry). `contribution` is the same JSON the HTTP route takes.
// hub -> worker  contribute.ack  accepted | duplicate (both: drop the item) | rejected (terminal: do NOT retry; `code` says why).
// hub -> worker  receipt         a librarian receipt for `wolf` (file `name`, text `content`); `id` is stable per receipt content.
// worker -> hub  receipt.ack     the worker durably wrote the receipt; the hub stops resending it. Unacked receipts are resent on reconnect.
export const LINK_CONTRIBUTION_MAX_BYTES = 1024 * 1024;
export const LINK_RECEIPT_MAX_BYTES = 256 * 1024;
export const LinkContributeSchema = z.object({
  t: z.literal("contribute"),
  id: z.string().min(1).max(128),
  wolf: z.string().min(1).max(64),
  contribution: z.record(z.string(), z.unknown()),
});
export const LinkContributeAckCodeSchema = z.enum(["foreign_wolf", "too_large", "invalid", "internal"]);
export type LinkContributeAckCode = z.infer<typeof LinkContributeAckCodeSchema>;
export const LinkContributeAckSchema = z.object({
  t: z.literal("contribute.ack"),
  id: z.string().min(1).max(128),
  status: z.enum(["accepted", "duplicate", "rejected"]),
  code: LinkContributeAckCodeSchema.optional(),
  message: z.string().optional(),
});
export const LinkReceiptSchema = z.object({
  t: z.literal("receipt"),
  id: z.string().min(1).max(128),
  wolf: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  content: z.string(),
});
export const LinkReceiptAckSchema = z.object({ t: z.literal("receipt.ack"), id: z.string().min(1).max(128) });
export type LinkContribute = z.infer<typeof LinkContributeSchema>;
export type LinkContributeAck = z.infer<typeof LinkContributeAckSchema>;
export type LinkReceipt = z.infer<typeof LinkReceiptSchema>;

export const LinkFrameSchema = z.discriminatedUnion("t", [
  LinkContributeSchema,
  LinkContributeAckSchema,
  LinkReceiptSchema,
  LinkReceiptAckSchema,
  LinkHelloSchema,
  LinkWelcomeSchema,
  LinkWolfAddSchema,
  LinkWolfRemoveSchema,
  LinkPingSchema,
  LinkPongSchema,
  LinkSleepSchema,
  LinkByeSchema,
  LinkErrorSchema,
  LinkReqSchema,
  LinkResSchema,
  LinkChunkSchema,
  LinkEndSchema,
  LinkCancelSchema,
  LinkRerrSchema,
]);
export type LinkFrame = z.infer<typeof LinkFrameSchema>;
export type LinkHello = z.infer<typeof LinkHelloSchema>;
export type LinkWelcome = z.infer<typeof LinkWelcomeSchema>;

export type ParsedFrame = { ok: true; frame: LinkFrame } | { ok: false; reason: string };
/** Parse one text frame. Never throws. */
export function parseLinkFrame(text: string): ParsedFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const r = LinkFrameSchema.safeParse(raw);
  if (!r.success) {
    const t = raw && typeof raw === "object" ? (raw as { t?: unknown }).t : undefined;
    return { ok: false, reason: typeof t === "string" ? `bad or unknown frame "${t.slice(0, 40)}"` : "missing t" };
  }
  return { ok: true, frame: r.data };
}
export const encodeLinkFrame = (f: LinkFrame): string => JSON.stringify(f);

/** Same major version = compatible. */
export const linkCompatible = (v: number): boolean => Math.floor(v) === LINK_PROTOCOL_VERSION;

export const LinkPresenceSchema = z.enum(["online", "asleep", "offline"]);
export type LinkPresence = z.infer<typeof LinkPresenceSchema>;
