/**
 * Console relay: the hub tunnels a console's wolf-scoped /v1 request to the host that owns the wolf, over that host's link, and streams
 * the answer back. One socket carries many requests (ids `h-<n>`): `req` out; `res` (head), `chunk`* (base64 body) and `end`, or `rerr`, back.
 *
 * - Routing: wolf id -> registry host -> live link. A wolf that is unknown/retired is 404; a host that is not `online` (asleep, offline, or
 *   no wolf host) fails AT ONCE with 503 and a message + `details.presence` naming the state. Nothing is queued.
 * - Cancel: the HTTP client going away sends `cancel` to the worker. A dropped/replaced link fails every in-flight request of that link
 *   (503 before the head; the response is destroyed after it, so a stream ends like a lost connection).
 * - Backpressure: a client that cannot keep up (more than RELAY_MAX_BUFFERED bytes queued on its response) is cut off and cancelled.
 * - A `res` head must arrive within `headTimeoutMs` (default 30s): else 504 and `cancel`.
 * The caller (server.ts) authenticates and refuses worker tokens before calling `handle`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  LINK_RELAY_MAX_BODY,
  LINK_RELAY_MAX_INFLIGHT,
  PROTOCOL_VERSION_HEADER,
  type ErrorCode,
  type LinkFrame,
} from "@wolfpack/protocol";
import { HubError } from "./errors.js";
import type { Link } from "./link.js";
import type { Registry } from "./registry.js";

const RELAY_MAX_BUFFERED = 4 * 1024 * 1024;
/** Request headers that never cross the link (credentials of the hub hop, hop-by-hop, framing). */
const DROP_REQ = new Set(["authorization", "x-api-key", "cookie", "host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "content-length", "proxy-authorization", "x-wolfpack-actor", "expect"]);
const DROP_RES = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "content-length"]);

interface Pending {
  res: ServerResponse;
  hostId: string;
  epoch: number;
  started: boolean;
  done: boolean;
  headTimer?: NodeJS.Timeout;
}

export interface Relay {
  handle(req: IncomingMessage, res: ServerResponse, wolf: string): Promise<void>;
  onFrame(hostId: string, epoch: number, f: LinkFrame): void;
  onDown(hostId: string, epoch: number): void;
  inflight(): number;
}

export function createRelay(o: { link: Link; registry: Registry; bodyTimeoutMs?: number; log?: (m: string) => void }): Relay {
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
      if (Number.isFinite(declared) && declared > LINK_RELAY_MAX_BODY) {
        req.resume();
        return reject(new HubError("invalid_request", `request body too large for the relay (limit ${LINK_RELAY_MAX_BODY} bytes)`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => reject(new HubError("invalid_request", "timed out reading the request body")), o.bodyTimeoutMs ?? 10_000);
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > LINK_RELAY_MAX_BODY) {
          clearTimeout(timer);
          req.removeAllListeners("data");
          req.resume();
          return reject(new HubError("invalid_request", `request body too large for the relay (limit ${LINK_RELAY_MAX_BODY} bytes)`));
        }
        chunks.push(c);
      });
      req.once("error", () => (clearTimeout(timer), reject(new HubError("invalid_request", "request aborted"))));
      req.once("end", () => (clearTimeout(timer), resolve(Buffer.concat(chunks))));
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, wolf: string): Promise<void> {
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
    const sent = o.link.sendToHost(hostId, { t: "req", id, method: req.method ?? "GET", path: req.url ?? "/", headers, wolf, ...(body.length ? { body: body.toString("base64") } : {}) });
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
      for (const [k, v] of Object.entries(f.headers)) if (!DROP_RES.has(k.toLowerCase()) && k.toLowerCase() !== PROTOCOL_VERSION_HEADER.toLowerCase()) out[k] = v;
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
      if (res.writableLength > RELAY_MAX_BUFFERED) {
        log(`hubd: relay ${f.id} to ${hostId}: client too slow (${res.writableLength} bytes queued); cutting it off`);
        return abort(f.id, p, () => res.destroy());
      }
      res.write(f.enc === "utf8" ? Buffer.from(f.data, "utf8") : Buffer.from(f.data, "base64"));
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

  function onDown(hostId: string, epoch: number): void {
    for (const [id, p] of [...pending]) {
      if (p.hostId !== hostId || p.epoch !== epoch) continue;
      finish(id, p);
      envelope(p.res, 503, "engine_error", `the link to host ${hostId} dropped while the request was in flight`, true, { presence: o.link.presence(hostId), host: hostId });
    }
  }

  return { handle, onFrame, onDown, inflight: () => pending.size };
}
