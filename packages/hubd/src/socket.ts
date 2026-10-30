/** Unix-socket listening for hubd (reverse-proxy mode, e.g. behind Caddy). Explicit, never world-accessible permissions; stale-socket handling. */
import { chmodSync, lstatSync, statSync, unlinkSync } from "node:fs";
import { connect, type Server } from "node:net";
import { dirname, isAbsolute } from "node:path";

export const DEFAULT_SOCKET_MODE = 0o660;
/** sun_path is 104 bytes on macOS and 108 on Linux, including the NUL: 103 and 107 usable. We enforce the stricter (macOS) one on both. */
const MAX_PATH = 103;
const PROBE_TIMEOUT_MS = 1000;

/** Identity of the socket file we bound; removal only ever unlinks this exact inode. */
export interface SocketIdentity {
  dev: number;
  ino: number;
}

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
  const dir = dirname(p);
  let st;
  try {
    st = lstatSync(dir);
    if (st.isSymbolicLink()) st = statSync(dir); // e.g. /tmp -> /private/tmp: judge the target
  } catch {
    throw new Error(`socket directory ${dir} does not exist`);
  }
  if (!st.isDirectory()) throw new Error(`socket directory ${dir} is not a directory`);
  if (st.mode & 0o002 && !(st.mode & 0o1000)) throw new Error(`socket directory ${dir} is world-writable without the sticky bit; anyone could replace the socket. Use a private directory (0750)`);
}

/** Remove a leftover socket file from a dead hubd. Refuses a non-socket file and a socket something still answers on. */
export async function clearStaleSocket(p: string, probeTimeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${p} exists and is not a socket; refusing to remove it`);
  const probe = await new Promise<string>((resolve) => {
    const c = connect(p);
    const timer = setTimeout(() => (c.destroy(), resolve("timeout")), probeTimeoutMs);
    const done = (v: string) => (clearTimeout(timer), resolve(v));
    c.once("connect", () => (c.destroy(), done("alive")));
    c.once("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? "dead" : `error:${err.code ?? err.message}`));
  });
  if (probe === "alive") throw new Error(`${p} is in use by a running process; refusing to start`);
  if (probe === "timeout") throw new Error(`${p} did not answer within ${probeTimeoutMs}ms; assuming it is in use and refusing to start`);
  if (probe !== "dead") throw new Error(`cannot tell whether ${p} is stale (${probe.slice(6)}); refusing to remove it`);
  try {
    unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Listen on `p` with the socket created under a umask that already excludes everyone else, then chmod to exactly `mode`.
 * Returns the bound file's identity for `removeSocket`. Callers hold the data-dir writer lock (taken at the top of
 * createHubServer, before this runs), so two hubds on one data dir cannot race the stale-check/unlink here.
 */
export async function listenOnSocket(server: Server, p: string, mode: number): Promise<SocketIdentity> {
  assertSafeSocketMode(mode);
  assertSocketPath(p);
  await clearStaleSocket(p);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The bind must stay synchronous inside this umask window: process.umask is process-wide, so nothing async may run between
    // set and restore, or other code would create files with umask 077.
    const old = process.umask(0o077);
    try {
      server.listen(p, () => resolve());
    } finally {
      process.umask(old);
    }
  });
  chmodSync(p, mode);
  const st = lstatSync(p);
  return { dev: st.dev, ino: st.ino };
}

/** Unlink `p` only if it is still the socket we bound (same dev+inode). Never removes something another process put there. */
export function removeSocket(p: string, id: SocketIdentity | undefined): void {
  if (!id) return;
  try {
    const st = lstatSync(p);
    if (st.isSocket() && st.dev === id.dev && st.ino === id.ino) unlinkSync(p);
  } catch {
    /* already gone */
  }
}
