/**
 * Console relay: the hub tunnels a console's wolf-scoped /v1 request to the host that owns the wolf, over that host's link, and streams
 * the answer back. One socket carries many requests (ids `h-<n>`): `req` out; `res` (head), `chunk`* (base64 body) and `end`, or `rerr`, back.
 *
 * - Routing: wolf id -> registry host -> live link. A wolf that is unknown/retired is 404; a host that is not `online` (asleep, offline, or
 *   no wolf host) fails AT ONCE with 503 and a message + `details.presence` naming the state. Nothing is queued.
 * - Cancel: the HTTP client going away sends `cancel` to the worker. A dropped/replaced link fails every in-flight request of that link
 *   (503 before the head; the response is destroyed after it, so a stream ends like a lost connection).
 * - Backpressure: per-request `pause`/`resume` frames (above LINK_RELAY_PAUSE_HIGH queued on the client's response); a worker that ignores
 *   pause is cut off at the hard caps below. A client whose socket makes no progress for the stall window is cut off too.
 * - A `res` head must arrive within `headTimeoutMs` (default 30s): else 504 and `cancel`.
 * The caller (server.ts) authenticates and refuses worker tokens before calling `handle`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  LINK_RELAY_CHUNK_BYTES,
  LINK_RELAY_HARD_SLACK,
  LINK_RELAY_HOST_BUFFERED,
  LINK_RELAY_MAX_BODY,
  LINK_RELAY_PAUSE_HIGH,
  LINK_RELAY_MAX_INFLIGHT,
  PROTOCOL_VERSION_HEADER,
  type ErrorCode,
  type LinkFrame,
} from "@wolfpack/protocol";
import { HubError } from "./errors.js";
import type { Link } from "./link.js";
import type { Registry } from "./registry.js";

/**
 * Flow control: above PAUSE_HIGH queued on a client's response the hub sends `pause` (once per paused state); when the response drains
 * it sends `resume`. A worker that ignores pause is cut off at the hard caps: PAUSE_HIGH + HARD_SLACK per request, LINK_RELAY_HOST_BUFFERED summed per host.
 * The no-progress timer cuts a response only when its socket stops moving bytes for DRAIN_STALL_MS; a slow but advancing reader is never cut.
 */
const RELAY_HARD_BUFFERED = LINK_RELAY_PAUSE_HIGH + LINK_RELAY_HARD_SLACK;
const RELAY_MAX_BUFFERED_HOST = LINK_RELAY_HOST_BUFFERED;
const DRAIN_STALL_MS = 30_000;
/** Request headers that never cross the link (credentials of the hub hop, hop-by-hop, framing). */
const DROP_REQ = new Set(["authorization", "x-api-key", "cookie", "host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "content-length", "proxy-authorization", "x-wolfpack-actor", "expect"]);
const DROP_RES = (k: string) => ["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization", "content-length", "set-cookie", "set-cookie2", "host"].includes(k) || k.startsWith("access-control-");

interface Pending {
  res: ServerResponse;
  hostId: string;
  epoch: number;
  started: boolean;
  done: boolean;
  headTimer?: NodeJS.Timeout;
  stallTimer?: NodeJS.Timeout;
  /** A `pause` is outstanding (no `resume` sent yet). */
  paused?: boolean;
  drainWatch?: boolean;
  /** Socket bytes written when the stall timer was last armed. */
  stallMark?: number;
}

export interface Relay {
  /** `path` is pathname+search of the URL the caller routed on; it is what crosses the link. */
  handle(req: IncomingMessage, res: ServerResponse, wolf: string, path: string): Promise<void>;
  onFrame(hostId: string, epoch: number, f: LinkFrame): void;
  onDown(hostId: string, epoch: number): void;
  inflight(): number;
}

export function createRelay(o: { link: Link; registry: Registry; bodyTimeoutMs?: number; /** @internal TEST-ONLY */ stallMs?: number; /** @internal TEST-ONLY: per-host cap override */ hostBuffered?: number; log?: (m: string) => void }): Relay {
  const stallMs = o.stallMs ?? DRAIN_STALL_MS;
  const hostCap = o.hostBuffered ?? RELAY_MAX_BUFFERED_HOST;
  const pending = new Map<string, Pending>();
  const perHost = new Map<string, number>();
  const log = o.log ?? ((m: string) => console.log(m));
  let n = 0;

  const bump = (host: string, d: number) => perHost.set(host, Math.max(0, (perHost.get(host) ?? 0) + d));

  function envelope(res: ServerResponse, status: number, code: ErrorCode, message: string, retryable: boolean, details?: Record<string, string>): void {
    if (res.headersSent) return void res.destroy();
    const body = JSON.stringify({ code, message, retryable, ...(details ? { details } : {}) });
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  function finish(id: string, p: Pending): void {
    if (p.done) return;
    p.done = true;
    clearTimeout(p.headTimer);
    clearTimeout(p.stallTimer);
    pending.delete(id);
    bump(p.hostId, -1);
  }

  /** Stop a request on our side and tell the worker. */
  function abort(id: string, p: Pending, fail?: () => void): void {
    if (p.done) return;
    finish(id, p);
    if (o.link.epoch(p.hostId) === p.epoch) o.link.sendToHost(p.hostId, { t: "cancel", id });
    fail?.();
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (req.method === "GET" || req.method === "HEAD") {
        req.resume();
        return resolve(Buffer.alloc(0));
      }
      const declared = Number(req.headers["content-length"]);
      const tooBig = () => new HubError("invalid_request", `request body too large for the relay (limit ${LINK_RELAY_MAX_BODY} bytes)`);
      if (Number.isFinite(declared) && declared > LINK_RELAY_MAX_BODY) {
        req.resume();
        return reject(tooBig());
      }
      const chunks: Buffer[] = [];
      let size = 0;
      // One exit: clears the timer and removes every listener, whatever ended the read.
      const exit = (err: HubError | undefined, drain: boolean) => {
        clearTimeout(timer);
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.on("error", () => {}); // a late socket error must not be unhandled
        if (drain) req.resume();
        if (err) reject(err);
        else resolve(Buffer.concat(chunks));
      };
      const onData = (c: Buffer) => {
        size += c.length;
        if (size > LINK_RELAY_MAX_BODY) return exit(tooBig(), true);
        chunks.push(c);
      };
      const onEnd = () => exit(undefined, false);
      const onError = () => exit(new HubError("invalid_request", "request aborted"), false);
      const timer = setTimeout(() => exit(new HubError("invalid_request", "timed out reading the request body"), true), o.bodyTimeoutMs ?? 10_000);
      req.on("data", onData);
      req.once("end", onEnd);
      req.once("error", onError);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, wolf: string, path: string): Promise<void> {
    // Only origin-form paths cross the link (an absolute-form or `//host` target is never forwarded, whatever the worker does with it).
    if (!/^\/(?![/\\])[^\s\u0000-\u001f\u007f]*$/.test(path) || (req.url ?? "").startsWith("//") || !(req.url ?? "").startsWith("/")) {
      req.resume();
      throw new HubError("invalid_request", "request target must be origin-form");
    }
    let entry: { host?: string; status?: string };
    try {
      entry = o.registry.get("wolves", wolf) as { host?: string; status?: string };
    } catch {
      req.resume();
      throw new HubError("not_found", `unknown wolf: ${wolf.slice(0, 64)}`);
    }
    if (entry.status === "retired") {
      req.resume();
      throw new HubError("not_found", `wolf ${wolf.slice(0, 64)} is retired`);
    }
    const hostId = entry.host;
    // Fail at once (before reading any body) when the host cannot answer; the state is named.
    const presence = hostId ? o.link.presence(hostId) : "offline";
    const epoch = hostId ? o.link.epoch(hostId) : undefined;
    if (!hostId || presence !== "online" || epoch === undefined) {
      req.resume();
      const state = hostId ? presence : "offline";
      const why = hostId ? `host ${hostId} is ${state}` : "it has no connected host";
      return envelope(res, 503, "engine_error", `wolf ${wolf.slice(0, 64)} is ${state}: ${why}`, true, { presence: state, ...(hostId ? { host: hostId } : {}) });
    }
    if ((perHost.get(hostId) ?? 0) >= LINK_RELAY_MAX_INFLIGHT) {
      req.resume();
      return envelope(res, 503, "busy", `too many requests in flight to host ${hostId}`, true);
    }
    const body = await readBody(req);
    // The link may have dropped while the body was read.
    if (o.link.presence(hostId) !== "online" || o.link.epoch(hostId) !== epoch) {
      const state = o.link.presence(hostId);
      return envelope(res, 503, "engine_error", `wolf ${wolf.slice(0, 64)} is ${state}: host ${hostId} is ${state}`, true, { presence: state, host: hostId });
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (DROP_REQ.has(k.toLowerCase()) || v === undefined) continue;
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
    }
    const id = `h-${++n}`;
    const p: Pending = { res, hostId, epoch, started: false, done: false };
    pending.set(id, p);
    bump(hostId, 1);
    // Client went away (or finished): stop the worker's work. `close` also fires after a normal end; abort() ignores a finished request.
    res.once("close", () => abort(id, p));
    p.headTimer = setTimeout(() => {
      log(`hubd: relay ${id} to ${hostId}: no response head in ${o.link.relayHeadTimeoutMs}ms; cancelling`);
      abort(id, p, () => envelope(res, 504, "engine_error", `wolf ${wolf.slice(0, 64)} did not answer in time`, true, { presence: "online" }));
    }, o.link.relayHeadTimeoutMs);
    p.headTimer.unref();
    const sent = o.link.sendToHost(hostId, { t: "req", id, method: req.method ?? "GET", path, headers, wolf, ...(body.length ? { body: body.toString("base64") } : {}) });
    if (!sent) {
      finish(id, p);
      const state = o.link.presence(hostId);
      envelope(res, 503, "engine_error", `wolf ${wolf.slice(0, 64)} is ${state}: host ${hostId} is ${state}`, true, { presence: state, host: hostId });
    }
  }

  function onFrame(hostId: string, epoch: number, f: LinkFrame): void {
    if (f.t !== "res" && f.t !== "chunk" && f.t !== "end" && f.t !== "rerr") return;
    const p = pending.get(f.id);
    // A frame for an unknown id (already cancelled/finished) or from another host's link is ignored: a worker can only answer its own requests.
    if (!p || p.hostId !== hostId || p.epoch !== epoch) return;
    const res = p.res;
    if (f.t === "res") {
      if (p.started) return;
      p.started = true;
      clearTimeout(p.headTimer);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(f.headers)) if (!DROP_RES(k.toLowerCase()) && k.toLowerCase() !== PROTOCOL_VERSION_HEADER.toLowerCase()) out[k] = v;
      try {
        res.writeHead(f.status, out);
        res.flushHeaders();
      } catch {
        abort(f.id, p, () => res.destroy());
      }
      return;
    }
    if (f.t === "chunk") {
      if (!p.started) return;
      // Bound the DECODED size for both encodings before decoding anything big.
      const utf8 = f.enc === "utf8";
      if (f.data.length > (utf8 ? LINK_RELAY_CHUNK_BYTES : Math.ceil((LINK_RELAY_CHUNK_BYTES * 4) / 3) + 4)) return tooBigChunk(f.id, p, hostId);
      const buf = utf8 ? Buffer.from(f.data, "utf8") : Buffer.from(f.data, "base64");
      if (buf.length > LINK_RELAY_CHUNK_BYTES) return tooBigChunk(f.id, p, hostId);
      if (res.writableLength + buf.length > RELAY_HARD_BUFFERED) {
        log(`hubd: relay ${f.id} to ${hostId}: client too slow (${res.writableLength} bytes queued); cutting it off`);
        return abort(f.id, p, () => res.destroy());
      }
      // Host cap: cut the request holding the LARGEST buffer (the hog), not whichever chunk happened to cross the cap.
      for (;;) {
        let hostBuffered = buf.length;
        let big: [string, Pending] | undefined;
        for (const [qid, q] of pending) {
          if (q.hostId !== hostId) continue;
          hostBuffered += q.res.writableLength;
          if (!big || q.res.writableLength > big[1].res.writableLength) big = [qid, q];
        }
        if (hostBuffered <= hostCap || !big) break;
        log(`hubd: relay ${big[0]} to ${hostId}: host buffer cap exceeded; cutting off the largest (${big[1].res.writableLength} bytes queued)`);
        abort(big[0], big[1], () => big![1].res.destroy());
        if (big[0] === f.id) return;
      }
      if (!res.write(buf)) {
        armStall(f.id, p, hostId);
        if (!p.paused && res.writableLength > LINK_RELAY_PAUSE_HIGH) {
          p.paused = true; // one pause per paused state
          o.link.sendToHost(hostId, { t: "pause", id: f.id });
        }
        if (!p.drainWatch) {
          p.drainWatch = true;
          res.once("drain", () => {
            p.drainWatch = false;
            clearTimeout(p.stallTimer);
            p.stallTimer = undefined;
            resumePaused(f.id, p, hostId); // drain: the queue is empty (node flushes its buffered chunks in one batch, so there is no earlier reliable point)
          });
        }
      }
      return;
    }
    if (f.t === "end") {
      finish(f.id, p);
      if (!p.started) return envelope(res, 502, "engine_error", "worker ended the request without a response", true);
      return void res.end();
    }
    // rerr
    finish(f.id, p);
    if (!p.started) return envelope(res, 502, "engine_error", `worker failed the request: ${f.code}${f.message ? `: ${f.message.slice(0, 200)}` : ""}`, true, { code: f.code.slice(0, 40) });
    res.destroy();
  }

  /** One `resume` per paused state. */
  function resumePaused(id: string, p: Pending, hostId: string): void {
    if (!p.paused || p.done) return;
    p.paused = false;
    if (o.link.epoch(hostId) === p.epoch) o.link.sendToHost(hostId, { t: "resume", id });
  }

  /** No-progress timer: fires only if the client's socket moved no bytes over a whole window (slow-but-advancing readers survive). */
  function armStall(id: string, p: Pending, hostId: string): void {
    if (p.stallTimer) return;
    p.stallMark = p.res.socket?.bytesWritten ?? 0;
    p.stallTimer = setTimeout(function check() {
      p.stallTimer = undefined;
      if (p.done) return;
      const now = p.res.socket?.bytesWritten ?? 0;
      if (now > (p.stallMark ?? 0)) return armStall(id, p, hostId); // still draining
      log(`hubd: relay ${id} to ${hostId}: client not draining for ${stallMs}ms; cutting it off`);
      abort(id, p, () => p.res.destroy());
    }, stallMs);
    p.stallTimer.unref();
  }

  function tooBigChunk(id: string, p: Pending, hostId: string): void {
    log(`hubd: relay ${id} to ${hostId}: oversized chunk; failing the request`);
    abort(id, p, () => envelope(p.res, 502, "engine_error", "worker sent an oversized chunk", true));
  }

  function onDown(hostId: string, epoch: number): void {
    for (const [id, p] of [...pending]) {
      if (p.hostId !== hostId || p.epoch !== epoch) continue;
      finish(id, p);
      envelope(p.res, 503, "engine_error", `the link to host ${hostId} dropped while the request was in flight`, true, { presence: o.link.presence(hostId), host: hostId });
    }
  }

  return { handle, onFrame, onDown, inflight: () => pending.size };
}
