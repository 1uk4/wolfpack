/**
 * The policy path's HTTP client. Every request the page makes is performed HERE (not by the browser), so the address
 * connected to is the one `guardedLookup` vetted: no check-then-connect gap for DNS rebinding.
 * Redirects are never followed (the caller vets Location and hands the 3xx to the browser).
 */
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

export interface FetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | null;
  lookup: (hostname: string, options: unknown, cb?: any) => void;
  /** Abort when the body exceeds this many bytes (content-length up front, then while streaming). */
  maxBytes: number;
  /** Abort when nothing has happened (connect, headers, a body chunk) for this many ms. */
  timeoutMs: number;
}

export interface FetchResult {
  status: number;
  /** Lowercased names; set-cookie kept as an array. */
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/** Headers a proxy-like hop must not forward. */
export const HOP_BY_HOP = ["host", "content-length", "connection", "keep-alive", "te", "trailer", "upgrade", "expect", "proxy-connection", "transfer-encoding"];

/** Decode a (possibly chained) content-encoding, bounded by maxBytes. Unknown encodings throw. */
export function decodeBody(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  if (body.length === 0) return body; // HEAD / 204 / 304 may still name an encoding
  const encs = (encoding ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => e && e !== "identity").reverse();
  let out = body;
  for (const e of encs) {
    const opts = { maxOutputLength: maxBytes };
    try {
      if (e === "gzip" || e === "x-gzip") out = zlib.gunzipSync(out, opts);
      else if (e === "br") out = zlib.brotliDecompressSync(out, opts);
      else if (e === "deflate") {
        try { out = zlib.inflateSync(out, opts); } catch { out = zlib.inflateRawSync(out, opts); }
      } else throw new Error(`unsupported content-encoding "${e}"`);
    } catch (err) {
      throw new Error(err instanceof Error && err.message.startsWith("unsupported") ? err.message : `could not decode ${e} response: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}

export function guardedFetch(o: FetchOptions): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(o.url);
    u.username = "";
    u.password = "";
    const lib = u.protocol === "https:" ? https : http;
    let done = false;
    const finish = (err: Error | undefined, res?: FetchResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(res!);
    };
    const req = lib.request(
      u,
      { method: o.method, headers: o.headers, lookup: o.lookup as any, agent: false },
      (res) => {
        if (/^text\/event-stream/i.test(String(res.headers["content-type"] ?? ""))) {
          res.destroy();
          return finish(new Error("server-sent events (text/event-stream) are not supported by this browser"));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > o.maxBytes) {
          res.destroy();
          return finish(new Error(`response too large (${declared} bytes > ${o.maxBytes})`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          arm();
          size += c.length;
          if (size > o.maxBytes) {
            res.destroy();
            return finish(new Error(`response exceeded ${o.maxBytes} bytes`));
          }
          chunks.push(c);
        });
        res.on("end", () => {
          try {
            const headers = res.headers as FetchResult["headers"];
            finish(undefined, { status: res.statusCode ?? 0, headers, body: decodeBody(Buffer.concat(chunks), String(headers["content-encoding"] ?? ""), o.maxBytes) });
          } catch (e) {
            finish(e as Error);
          }
        });
        res.on("error", (e) => finish(e));
        res.on("aborted", () => finish(new Error("response aborted")));
      },
    );
    let timer: NodeJS.Timeout;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(`request idle for ${o.timeoutMs}ms; timed out`)), o.timeoutMs);
    };
    arm();
    req.on("error", (e) => finish(e));
    if (o.body && o.body.length) req.write(o.body);
    req.end();
  });
}
