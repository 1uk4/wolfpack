/**
 * Hub <-> workerd link frames (one WebSocket per host, GET /v1/link). JSON text frames discriminated on `t`.
 * LINK_PROTOCOL_VERSION is separate from the HTTP PROTOCOL_VERSION; a MAJOR mismatch is rejected (close 4001).
 * Relay frames (req/res/chunk/end/cancel/rerr) are defined here for the relay ticket; nothing handles them yet.
 * Request ids are prefixed by the side that opened them: `h-` (hub) or `w-` (worker).
 */
import { z } from "zod";

export const LINK_PROTOCOL_VERSION = 1;
export const LINK_PATH = "/v1/link";
export const LINK_MAX_PAYLOAD = 8 * 1024 * 1024;
export const LINK_HELLO_TIMEOUT_MS = 10_000;
export const LINK_HEARTBEAT_MS = 10_000;
export const LINK_DEAD_AFTER_MS = 30_000;

export const LINK_CLOSE = {
  clean: 1000,
  incompatible: 4001,
  noHello: 4400,
  unauthorized: 4401,
  replaced: 4409,
} as const;

const Id = z.string().min(1).max(64);
const Revisions = z.record(z.string(), z.number().int().nonnegative());

export const LinkWolfSchema = z.object({ name: z.string().min(1).max(64), domains: z.array(z.string().min(1)).default([]) });
export type LinkWolf = z.infer<typeof LinkWolfSchema>;

export const LinkErrorCodeSchema = z.enum(["version_mismatch", "unauthorized", "bad_frame", "replaced"]);
export type LinkErrorCode = z.infer<typeof LinkErrorCodeSchema>;

export const LinkHelloSchema = z.object({
  t: z.literal("hello"),
  v: z.number().int().nonnegative(),
  hostId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64),
  laptop: z.boolean(),
  wolves: z.array(LinkWolfSchema),
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

export const LinkFrameSchema = z.discriminatedUnion("t", [
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
