/** Unix-socket helpers for wolfd: liveness probe + stale-socket cleanup. */
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { request } from "node:http";
import { dirname } from "node:path";

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

/**
 * Make `path` bindable: create its dir (0700); if a socket file is there, refuse when a live server answers on it
 * (another wolfd owns this wolf), otherwise remove the stale file.
 */
export async function prepareSocketPath(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) return;
  if (await probeSocket(path)) throw new Error(`another wolfd is already serving on ${path}`);
  rmSync(path, { force: true });
}
