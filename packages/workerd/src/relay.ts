/**
 * Worker side of the console relay: a `req` frame from the hub becomes a request to this workerd's own local /v1 (loopback HTTP, so
 * the proxy, version gate and routing are exactly the ones a local console gets), and the answer goes back as res / chunk* / end (or rerr).
 * `cancel` (or a link drop) aborts the local request. `pause`/`resume` from the hub stop/restart reading the local response (so no chunk
 * frames are sent while the hub's client is slow). Only the hub opens requests.
 *
 * SSRF: the frame is untrusted. Host and port ALWAYS come from `baseUrl`; `path` must be origin-form ("/x", not "//x", not absolute) and must
 * resolve to baseUrl's own origin, else the request is refused with rerr before anything connects.
 * Backpressure: bytes handed to the socket are counted until ws's send callback fires; above HIGH_WATER the local response is paused.
 */
import { request as httpRequest } from "node:http";
import { LINK_RELAY_CHUNK_BYTES, LINK_RELAY_MAX_BODY, LINK_RELAY_MAX_INFLIGHT, type LinkFrame } from "@wolfpack/protocol";

type Req = Extract<LinkFrame, { t: "req" }>;
/** Never copied from the worker's response (hop-by-hop, framing, cookies and CORS belong to the worker's origin, not the hub's). */
const SKIP_RES = (k: string) => HOP.has(k) || k === "set-cookie" || k === "set-cookie2" || k.startsWith("access-control-");
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization", "content-length", "host"]);
const SKIP_REQ = new Set(["authorization", "cookie", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "content-length", "host", "expect"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = HIGH_WATER / 4;
const MAX_B64 = Math.ceil((LINK_RELAY_MAX_BODY * 4) / 3) + 4;

export interface WorkerRelayOptions {
  /** Base URL of this workerd's local server (read lazily: it is known only after listen). */
  baseUrl: () => string;
  /** Send a frame; `written` fires when the socket has flushed it. False when the link is not online. */
  send: (f: LinkFrame, written?: (err?: Error) => void) => boolean;
}

export class WorkerRelay {
  private readonly live = new Map<string, { abort: () => void; hubPause: (on: boolean) => void }>();
  private queued = 0;
  private readonly paused = new Set<() => void>();
  constructor(private readonly o: WorkerRelayOptions) {}

  inflight(): number {
    return this.live.size;
  }
  cancel(id: string): void {
    this.live.get(id)?.abort();
  }
  /** Hub flow control: stop (true) / restart (false) reading the local response of this request. Unknown ids are ignored. */
  hubPause(id: string, on: boolean): void {
    this.live.get(id)?.hubPause(on);
  }
  abortAll(): void {
    for (const e of [...this.live.values()]) e.abort();
    this.queued = 0;
    this.paused.clear();
  }

  private sendCounted(f: LinkFrame, bytes: number): void {
    this.queued += bytes;
    const ok = this.o.send(f, () => {
      this.queued = Math.max(0, this.queued - bytes);
      if (this.queued <= LOW_WATER) for (const resume of [...this.paused]) (this.paused.delete(resume), resume());
    });
    if (!ok) this.queued = Math.max(0, this.queued - bytes);
  }

  /** Never throws: anything wrong is answered with rerr. */
  handle(f: Req): void {
    try {
      this.run(f);
    } catch (e) {
      this.live.delete(f.id);
      this.o.send({ t: "rerr", id: f.id, code: "internal", message: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }

  private run(f: Req): void {
    const { id } = f;
    if (this.live.has(id)) return;
    const refuse = (code: string, message: string) => void this.o.send({ t: "rerr", id, code, message });
    if (this.live.size >= LINK_RELAY_MAX_INFLIGHT) return refuse("busy", "too many requests in flight on this worker");
    if (!METHODS.has(f.method)) return refuse("bad_request", "method not allowed");
    // Origin-form only; "//host", "/\host", absolute URLs and control characters are refused, then the origin is double-checked.
    if (!/^\/(?![/\\])[^\s\u0000-\u001f\u007f]*$/.test(f.path)) return refuse("bad_request", "path must be origin-form");
    const base = new URL(this.o.baseUrl());
    let resolved: URL;
    try {
      resolved = new URL(f.path, base);
    } catch {
      return refuse("bad_request", "bad path");
    }
    if (resolved.origin !== base.origin) return refuse("bad_request", "path leaves the worker origin");
    if (f.body !== undefined && f.body.length > MAX_B64) return refuse("bad_request", "request body too large");
    const body = f.body ? Buffer.from(f.body, "base64") : undefined;
    if (body && body.length > LINK_RELAY_MAX_BODY) return refuse("bad_request", "request body too large");

    let finished = false;
    let up: ReturnType<typeof httpRequest> | undefined;
    let seq = 0;
    let resume: (() => void) | undefined;
    let upstream: import("node:http").IncomingMessage | undefined;
    let hubPaused = false;
    let queuePaused = false;
    const apply = () => {
      if (finished || !upstream) return;
      if (hubPaused || queuePaused) upstream.pause();
      else upstream.resume();
    };
    const done = () => {
      finished = true;
      this.live.delete(id);
      if (resume) this.paused.delete(resume);
    };
    const abort = () => {
      if (finished) return;
      done();
      up?.destroy();
    };
    const fail = (code: string, message: string) => {
      if (finished) return;
      done();
      up?.destroy();
      this.o.send({ t: "rerr", id, code, message: message.slice(0, 300) });
    };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(f.headers)) if (!SKIP_REQ.has(k.toLowerCase())) headers[k] = v;
    if (body) headers["content-length"] = String(body.length);
    this.live.set(id, { abort, hubPause: (on) => ((hubPaused = on), apply()) });
    // Host and port are the worker's own; only the (validated) path comes from the frame.
    up = httpRequest({ hostname: base.hostname, port: base.port, path: f.path, method: f.method, headers }, (ur) => {
      if (finished) return void ur.destroy();
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!SKIP_RES(k) && v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
      this.o.send({ t: "res", id, status: ur.statusCode ?? 502, headers: out });
      upstream = ur;
      resume = () => {
        queuePaused = false;
        apply();
      };
      apply(); // a pause may have arrived before the head
      ur.on("data", (buf: Buffer) => {
        if (finished) return;
        for (let i = 0; i < buf.length; i += LINK_RELAY_CHUNK_BYTES) {
          const part = buf.subarray(i, i + LINK_RELAY_CHUNK_BYTES);
          this.sendCounted({ t: "chunk", id, seq: seq++, enc: "b64", data: part.toString("base64") }, part.length);
        }
        if (this.queued > HIGH_WATER) {
          queuePaused = true;
          apply();
          this.paused.add(resume!);
        }
      });
      ur.on("end", () => {
        if (finished) return;
        done();
        this.o.send({ t: "end", id });
      });
      ur.on("error", (e) => fail("upstream_error", e.message));
      ur.on("close", () => {
        if (!finished && !ur.complete) fail("upstream_error", "local response ended early");
      });
    });
    up.on("error", (e) => fail("upstream_error", e.message));
    up.end(body);
  }
}
