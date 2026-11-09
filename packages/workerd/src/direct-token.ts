/**
 * The DIRECT CONSOLE TOKEN (work-wolfpack-Fy45EOA): a local secret that lets a console on THIS machine talk to workerd's /direct/v1
 * while the hub is unreachable. It lives in `<configDir>/direct-token` (default ~/.wolfpack/workerd/direct-token, mode 0600, created on
 * first use with 32 random bytes) and never leaves the machine: workerd only reads it, the console reads the same file
 * (WOLFPACK_WORKERD_DIRECT_TOKEN_FILE), and /direct/v1 refuses any caller that is not on loopback.
 *
 * Creation is atomic: the token is written to a private temp file and hard-linked into place, so a reader never sees an empty or partial
 * file, and when two processes race the loser's link fails (EEXIST) and it reads the winner's token. Every read lstat()s the file first:
 * a symlink or a file owned by another user is refused (never healed); a mode looser than 0600 is tightened (logged once). A file of our
 * own whose content is empty or not a token is healed: a fresh token is linked in, or renamed over it if it stays invalid. Reads are
 * cached by inode and mtime, so a request costs one lstat.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerdConfigDir } from "./hub-config.js";

/** The header the console sends the token in (never Authorization: that one is the hub's). */
export const DIRECT_TOKEN_HEADER = "x-wolfpack-direct-token";
export const directTokenFile = (dir = workerdConfigDir()): string => join(dir, "direct-token");

const VALID = /^[A-Za-z0-9_-]{32,128}$/;
const cache = new Map<string, { ino: number; mtimeMs: number; size: number; token: string }>();
const tightened = new Set<string>();

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The file is ours and regular but its content is empty or not a token: the one case that may be healed (replaced). */
class InvalidTokenContent extends Error {}

/** The checked token in `file`; undefined when the file is missing. Throws on a symlink, a foreign owner or invalid content. */
function readChecked(file: string, log: (m: string) => void): string | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`${file} is a symlink; refusing it as the direct token`);
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${file} is owned by another user (uid ${st.uid})`);
  if ((st.mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
    if (!tightened.has(file)) {
      tightened.add(file);
      log(`[workerd] ${file} had mode ${(st.mode & 0o777).toString(8)}; tightened to 600`);
    }
  }
  const hit = cache.get(file);
  if (hit && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.token;
  const token = readFileSync(file, "utf8").trim();
  if (!VALID.test(token)) throw new InvalidTokenContent(`${file} does not hold a valid direct token`);
  cache.set(file, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, token });
  return token;
}

/** The token in `dir`, creating it (0600, dir 0700) when missing. Concurrent callers all get the same token. */
export function ensureDirectToken(dir = workerdConfigDir(), log: (m: string) => void = console.warn): string {
  const file = directTokenFile(dir);
  let have: string | undefined;
  try {
    have = readChecked(file, log);
  } catch (e) {
    // Empty or invalid content (a crash mid-write by an older version, a hand edit): fall through and replace it below.
    // A symlink, a foreign owner or an I/O error is never healed.
    if (!(e instanceof InvalidTokenContent)) throw e;
  }
  if (have) return have;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  try {
    linkSync(tmp, file); // atomic: the name appears with its full content, or EEXIST
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // Lost the race (or a file appeared): the winner's file is complete. Retry briefly in case it was written some other, non-atomic way.
    for (let i = 0; i < 5; i++) {
      try {
        const t = readChecked(file, log);
        if (t) return t;
      } catch (err) {
        if (!(err instanceof InvalidTokenContent)) throw err; // symlink, foreign owner, I/O: never overwrite it
      }
      sleepSync(20);
    }
    renameSync(tmp, file); // still empty or invalid after the retries: replace it atomically
  } finally {
    rmSync(tmp, { force: true });
  }
  const t = readChecked(file, log);
  if (!t) throw new Error(`${file} vanished while it was being created`);
  return t;
}

/** Constant-time compare of a presented token with the expected one. */
export function directTokenMatches(presented: string | string[] | undefined, expected: string): boolean {
  if (typeof presented !== "string" || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
