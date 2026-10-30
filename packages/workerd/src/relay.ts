/**
 * Worker side of the console relay: a `req` frame from the hub becomes a request to this workerd's own local /v1 (loopback HTTP, so
 * the proxy, version gate and routing are exactly the ones a local console gets), and the answer goes back as res / chunk* / end (or rerr).
 * `cancel` (or a link drop) aborts the local request. Only the hub opens requests; frames are bounded by LINK_RELAY_CHUNK_BYTES raw.
 */
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { LINK_RELAY_CHUNK_BYTES, type LinkFrame } from "@wolfpack/protocol";

type Req = Extract<LinkFrame, { t: "req" }>;
const SKIP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "content-length", "host"]);
const HIGH_WATER = 1024 * 1024;

export interface WorkerRelayOptions {
  /** Base URL of this workerd's local server (read lazily: it is known only after listen). */
  baseUrl: () => string;
  send: (f: LinkFrame) => boolean;
  /** Bytes queued on the link socket (backpressure). */
  buffered: () => number;
}

export class WorkerRelay {
  private readonly live = new Map<string, () => void>();
  constructor(private readonly o: WorkerRelayOptions) {}

  inflight(): number {
    return this.live.size;
  }
  cancel(id: string): void {
    this.live.get(id)?.();
  }
  abortAll(): void {
    for (const abort of [...this.live.values()]) abort();
  }

  handle(f: Req): void {
    if (this.live.has(f.id)) return;
    const { id } = f;
    let finished = false;
    let up: ReturnType<typeof httpRequest> | undefined;
    let seq = 0;
    const done = () => {
      finished = true;
      this.live.delete(id);
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
    this.live.set(id, abort);
    const headers: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(f.headers)) if (!SKIP.has(k.toLowerCase())) headers[k] = v;
    const body = f.body ? Buffer.from(f.body, "base64") : undefined;
    if (body) headers["content-length"] = String(body.length);
    let target: URL;
    try {
      target = new URL(f.path, this.o.baseUrl());
    } catch {
      return fail("bad_request", "bad path");
    }
    up = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: f.method, headers }, (ur) => {
      if (finished) return void ur.destroy();
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!SKIP.has(k) && v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
      this.o.send({ t: "res", id, status: ur.statusCode ?? 502, headers: out });
      let timer: NodeJS.Timeout | undefined;
      ur.on("data", (buf: Buffer) => {
        if (finished) return;
        for (let i = 0; i < buf.length; i += LINK_RELAY_CHUNK_BYTES) {
          this.o.send({ t: "chunk", id, seq: seq++, enc: "b64", data: buf.subarray(i, i + LINK_RELAY_CHUNK_BYTES).toString("base64") });
        }
        if (this.o.buffered() > HIGH_WATER && !timer) {
          ur.pause();
          timer = setInterval(() => {
            if (finished || this.o.buffered() <= HIGH_WATER / 4) {
              clearInterval(timer);
              timer = undefined;
              if (!finished) ur.resume();
            }
          }, 10);
        }
      });
      ur.on("end", () => {
        if (finished) return;
        clearInterval(timer);
        done();
        this.o.send({ t: "end", id });
      });
      ur.on("error", (e) => (clearInterval(timer), fail("upstream_error", e.message)));
      ur.on("close", () => {
        clearInterval(timer);
        if (!finished && !ur.complete) fail("upstream_error", "local response ended early");
      });
    });
    up.on("error", (e) => fail("upstream_error", e.message));
    up.end(body);
  }
}
