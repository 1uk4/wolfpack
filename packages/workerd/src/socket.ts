import { request } from "node:http";

/** Upstream strings are `http://host:port` (TCP) or `unix:<path>` (socket). */
export const UNIX_PREFIX = "unix:";
export const socketOf = (upstream: string): string | undefined => (upstream.startsWith(UNIX_PREFIX) ? upstream.slice(UNIX_PREFIX.length) : undefined);

/** True when a live /v1 server answers GET /v1/wolves on the unix socket at `path`. */
export function probeSocket(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath: path, path: "/v1/wolves", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** GET <path> on an upstream (TCP or unix) and parse the JSON body. */
export function getJson(upstream: string, path: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = socketOf(upstream);
    const target = sock ? { socketPath: sock } : { hostname: new URL(upstream).hostname, port: new URL(upstream).port };
    const req = request({ ...target, path, method: "GET", timeout: timeoutMs }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}
