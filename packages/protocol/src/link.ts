/**
 * Hub <-> workerd link frames (one WebSocket per host, GET /v1/link). JSON text frames discriminated on `t`.
 * LINK_PROTOCOL_VERSION is separate from the HTTP PROTOCOL_VERSION; a MAJOR mismatch is rejected (close 4001).
 * Relay frames (req/res/chunk/end/cancel/rerr) tunnel the console's /v1 HTTP requests (SSE included) from the hub to a worker's local
 * /v1 handler. Only the hub opens requests (ids `h-<n>`); a worker answers with res (head), chunk* (body, base64) and end, or rerr.
 * `cancel` (hub -> worker) aborts a request whose HTTP client went away; `pause` / `resume` (hub -> worker, additive) are per-request flow control
 * (see LINK_RELAY_PAUSE_HIGH); a peer that does not know them ignores the frames. Additive over the v1 frames: `req.body` and `chunk.enc`
 * are optional, so a peer that never sends them is unchanged. A worker that does not know the relay ignores these frames.
 * Request ids are prefixed by the side that opened them: `h-` (hub) or `w-` (worker; reserved, not used yet).
 */
import { z } from "zod";

export const LINK_PROTOCOL_VERSION = 1;
export const LINK_PATH = "/v1/link";
/** Max frame size once the hello is accepted (before that: LINK_HELLO_MAX_PAYLOAD). */
export const LINK_MAX_PAYLOAD = 8 * 1024 * 1024;
/** Relay: max raw bytes per chunk frame (base64 grows it ~4/3; well below LINK_MAX_PAYLOAD). */
export const LINK_RELAY_CHUNK_BYTES = 256 * 1024;
/**
 * Relay flow control (hub -> worker `pause`/`resume`): the hub sends `pause {id}` when a client's response has more than
 * LINK_RELAY_PAUSE_HIGH bytes queued, and `resume {id}` once it drained (the response's `drain`; node flushes its queued chunks as one batch, so there is no reliable earlier point). A worker that honours `pause`
 * stops sending chunks for that id; one that ignores it (older worker) is still bounded by the hub's hard caps
 * (LINK_RELAY_PAUSE_HIGH + LINK_RELAY_HARD_SLACK queued per request, LINK_RELAY_HOST_BUFFERED per host) and is cut off, as before.
 */
export const LINK_RELAY_PAUSE_HIGH = 256 * 1024;
/**
 * Data already in flight when `pause` is sent (worker send queue + kernel socket buffers, several MB on a fast loopback/LAN link) still
 * arrives and must not count against a worker that honours pause: hence 16 MB of slack. The per-HOST cap (LINK_RELAY_HOST_BUFFERED) is the real memory bound.
 */
export const LINK_RELAY_HARD_SLACK = 16 * 1024 * 1024;
/** Relay: max bytes queued on client responses summed over one host's requests; beyond it the request that overflows is cut off. */
export const LINK_RELAY_HOST_BUFFERED = 32 * 1024 * 1024;
/** Relay: max request body the hub tunnels (raw bytes). */
export const LINK_RELAY_MAX_BODY = 2 * 1024 * 1024;
/** Relay: no `res` head within this after `req` = the hub gives up (504) and sends `cancel`. */
export const LINK_RELAY_HEAD_TIMEOUT_MS = 30_000;
/** Relay: max concurrent tunnelled requests per host. */
export const LINK_RELAY_MAX_INFLIGHT = 256;
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
  /** Additive: the KB domains the registry grants this host (union over its non-retired wolves). The worker syncs ONLY these. */
  grantedDomains: z.array(z.string().min(1).max(64)).max(1024).default([]),
});
/** Additive, hub -> worker: the host's granted KB domain union changed (registry edit, wolf.add accepted, retire). Replaces the previous set. */
export const LinkGrantsSchema = z.object({ t: z.literal("grants"), domains: z.array(z.string().min(1).max(64)).max(1024) });
export const LinkWolfAddSchema = z.object({ t: z.literal("wolf.add"), wolf: LinkWolfSchema });
export const LinkWolfRemoveSchema = z.object({ t: z.literal("wolf.remove"), name: z.string().min(1).max(64) });
export const LinkPingSchema = z.object({ t: z.literal("ping"), n: z.number().int() });
export const LinkPongSchema = z.object({ t: z.literal("pong"), n: z.number().int() });
export const LinkSleepSchema = z.object({ t: z.literal("sleep") });
export const LinkByeSchema = z.object({ t: z.literal("bye") });
export const LinkErrorSchema = z.object({ t: z.literal("error"), code: LinkErrorCodeSchema, message: z.string().optional() });

/**
 * Hub -> worker hint (additive, link protocol 1): domain `domain` reached revision `rev` under `epoch`. Sent only to hosts whose
 * non-retired wolves (per the registry) subscribe to the domain. The worker pulls the data over HTTP (GET /v1/kb/domains/:d/changes);
 * the frame carries no content and may be lost or coalesced: polling and sync-on-reconnect still converge.
 * A rotation of the domain epoch after a hub persist failure is NOT pushed: the worker notices it on the next write's push or its poll.
 */
export const LinkKbChangedSchema = z.object({ t: z.literal("kb.changed"), domain: z.string().min(1).max(64), rev: z.number().int().nonnegative(), epoch: z.string().min(1).max(128) });

// Relay frames.
export const LinkReqSchema = z.object({
  t: z.literal("req"),
  id: Id,
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  wolf: z.string().optional(),
  /** Additive: request body, base64 (at most LINK_RELAY_MAX_BODY raw bytes). Absent = no body. */
  body: z.string().optional(),
});
export const LinkResSchema = z.object({ t: z.literal("res"), id: Id, status: z.number().int(), headers: z.record(z.string(), z.string()).default({}) });
/** `data` is base64 when `enc` is "b64" (what workerd sends; at most LINK_RELAY_CHUNK_BYTES raw), else UTF-8 text. */
export const LinkChunkSchema = z.object({ t: z.literal("chunk"), id: Id, data: z.string(), seq: z.number().int().nonnegative(), enc: z.enum(["b64", "utf8"]).optional() });
export const LinkEndSchema = z.object({ t: z.literal("end"), id: Id });
export const LinkCancelSchema = z.object({ t: z.literal("cancel"), id: Id });
/** Additive (hub -> worker): stop / restart sending `chunk` frames for this request. Idempotent; unknown ids are ignored. */
export const LinkPauseSchema = z.object({ t: z.literal("pause"), id: Id });
export const LinkResumeSchema = z.object({ t: z.literal("resume"), id: Id });
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
  LinkKbChangedSchema,
  LinkGrantsSchema,
  LinkReqSchema,
  LinkResSchema,
  LinkChunkSchema,
  LinkEndSchema,
  LinkCancelSchema,
  LinkRerrSchema,
  LinkPauseSchema,
  LinkResumeSchema,
]);
export type LinkFrame = z.infer<typeof LinkFrameSchema>;
export type LinkHello = z.infer<typeof LinkHelloSchema>;
export type LinkGrants = z.infer<typeof LinkGrantsSchema>;
export type LinkKbChanged = z.infer<typeof LinkKbChangedSchema>;
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
