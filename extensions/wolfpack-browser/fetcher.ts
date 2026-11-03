/**
 * The policy path's HTTP client. Every request the page makes is performed HERE (not by the browser), so the address
 * connected to is the one `guardedLookup` vetted: no check-then-connect gap for DNS rebinding.
 * Redirects are never followed (the caller vets Location and hands the 3xx to the browser).
 */
import http from "node:http";
import https from "node:https";

export interface FetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | null;
  lookup: (hostname: string, options: unknown, cb?: any) => void;
  /** Abort when the body exceeds this many bytes (content-length up front, then while streaming). */
  maxBytes: number;
  /** Abort the whole exchange after this many ms. */
  timeoutMs: number;
}

export interface FetchResult {
  status: number;
  /** Lowercased names; set-cookie kept as an array. */
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export function guardedFetch(o: FetchOptions): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(o.url);
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
      o.url,
      { method: o.method, headers: o.headers, lookup: o.lookup as any, agent: false },
      (res) => {
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > o.maxBytes) {
          res.destroy();
          return finish(new Error(`response too large (${declared} bytes > ${o.maxBytes})`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) {
            res.destroy();
            return finish(new Error(`response exceeded ${o.maxBytes} bytes`));
          }
          chunks.push(c);
        });
        res.on("end", () => finish(undefined, { status: res.statusCode ?? 0, headers: res.headers as FetchResult["headers"], body: Buffer.concat(chunks) }));
        res.on("error", (e) => finish(e));
        res.on("aborted", () => finish(new Error("response aborted")));
      },
    );
    const timer = setTimeout(() => finish(new Error(`request timed out after ${o.timeoutMs}ms`)), o.timeoutMs);
    req.on("error", (e) => finish(e));
    if (o.body && o.body.length) req.write(o.body);
    req.end();
  });
}
