/** Unix-socket listening for hubd (reverse-proxy mode, e.g. behind Caddy). Explicit, never world-accessible permissions; stale-socket handling. */
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { connect, type Server } from "node:net";
import { dirname, isAbsolute } from "node:path";

export const DEFAULT_SOCKET_MODE = 0o660;
/** sun_path limit is 104 bytes on macOS, 108 on Linux. */
const MAX_PATH = 103;

/** Throws unless `mode` gives the owner rw and grants nothing to "other" (no world access, no setuid bits). */
export function assertSafeSocketMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error(`socket mode ${mode.toString(8)} is not a permission mode (0..0777)`);
  if ((mode & 0o600) !== 0o600) throw new Error(`socket mode ${mode.toString(8)} must give the owner read and write (0600)`);
  if (mode & 0o007) throw new Error(`socket mode ${mode.toString(8)} is world-accessible; refusing (use 0600 or 0660)`);
}

export function parseSocketMode(raw: string): number {
  if (!/^0?[0-7]{3,4}$/.test(raw.trim())) throw new Error(`socket mode must be octal such as 0660, got ${JSON.stringify(raw)}`);
  const m = parseInt(raw.trim(), 8);
  assertSafeSocketMode(m);
  return m;
}

export function assertSocketPath(p: string): void {
  if (!isAbsolute(p)) throw new Error(`socket path must be absolute, got ${JSON.stringify(p)}`);
  if (Buffer.byteLength(p) > MAX_PATH) throw new Error(`socket path is too long (${Buffer.byteLength(p)} > ${MAX_PATH} bytes)`);
  if (!existsSync(dirname(p))) throw new Error(`socket directory ${dirname(p)} does not exist`);
}

/** Remove a leftover socket file from a dead hubd. Refuses a non-socket file and a socket something still answers on. */
export async function clearStaleSocket(p: string): Promise<void> {
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${p} exists and is not a socket; refusing to remove it`);
  const alive = await new Promise<boolean>((resolve) => {
    const c = connect(p);
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", (err: NodeJS.ErrnoException) => resolve(err.code !== "ECONNREFUSED" && err.code !== "ENOENT"));
  });
  if (alive) throw new Error(`${p} is in use by a running process; refusing to start`);
  try {
    unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Listen on `p` with the socket created under a umask that already excludes everyone else, then chmod to exactly `mode`. */
export async function listenOnSocket(server: Server, p: string, mode: number): Promise<void> {
  assertSafeSocketMode(mode);
  assertSocketPath(p);
  await clearStaleSocket(p);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const old = process.umask(0o077);
    try {
      server.listen(p, () => resolve());
    } finally {
      process.umask(old);
    }
  });
  chmodSync(p, mode);
}

export function removeSocket(p: string): void {
  try {
    if (lstatSync(p).isSocket()) unlinkSync(p);
  } catch {
    /* already gone */
  }
}
