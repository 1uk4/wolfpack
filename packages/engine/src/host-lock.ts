/**
 * Host-local lock helpers shared by the subagent slots (harness) and the test queue (cli): liveness by pid plus process
 * start time, and a `mkdir` lock (atomic everywhere, no native deps) whose stale holders are broken safely.
 * The directories using them MUST be host-local (never synced or network-mounted).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_STALE_MS = 5_000;
export const LOCK_WAIT_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === "EPERM";
  }
}

const START_TTL_MS = 30_000;
const startCache = new Map<number, { v: string | undefined; at: number }>();

/** When the process started, as `ps` prints it (stable for the life of the process); undefined if unreadable. `fresh` bypasses the TTL cache (use it when recording a start, where a stale pid-reuse hit would be wrong). */
export function startOf(pid: number, cache?: Map<number, string | undefined>, fresh = false): string | undefined {
  if (cache?.has(pid)) return cache.get(pid);
  // Recently read values are reused (acquire runs often; ps is slow). A reused pid within the TTL is the only risk, and slots also check pidAlive.
  const hit = startCache.get(pid);
  let v: string | undefined;
  if (!fresh && hit && Date.now() - hit.at < START_TTL_MS) v = hit.v;
  else {
    try {
      // C locale and UTC: the same text whatever the user's locale or TZ, so a slot written by one wolfd compares equal in another.
      v = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim() || undefined;
    } catch {
      v = undefined;
    }
    if (startCache.size > 256) startCache.clear();
    startCache.set(pid, { v, at: Date.now() });
  }
  cache?.set(pid, v);
  return v;
}

function ownerOf(lock: string): string | undefined {
  try {
    return readFileSync(join(lock, "owner"), "utf8");
  } catch {
    return undefined;
  }
}

/** Leftover renamed-away locks in `dir` that are old enough to be certainly dead. */
export function sweepAway(dir: string): void {
  try {
    for (const n of readdirSync(dir)) {
      if (!n.startsWith(".lock.stale-")) continue;
      try {
        if (Date.now() - statSync(join(dir, n)).mtimeMs > 2 * LOCK_STALE_MS) rmSync(join(dir, n), { recursive: true, force: true });
      } catch {
        /* gone */
      }
    }
  } catch {
    /* no dir yet */
  }
}

/** Break a lock whose holder died: rename it away first (only one breaker wins), then delete it. */
export function breakStale(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return;
    const seen = ownerOf(lock);
    const away = `${lock}.stale-${randomUUID().slice(0, 8)}`;
    renameSync(lock, away);
    // Delete only with evidence it is the stale lock we looked at: same owner token, and still old.
    // No owner file yet (a taker between mkdir and write), another token, or a fresh mtime: not ours to delete.
    const now = ownerOf(away);
    let old = false;
    try {
      old = Date.now() - statSync(away).mtimeMs > LOCK_STALE_MS;
    } catch {
      /* gone */
    }
    // (An ownerless lock older than three stale periods cannot be a write in flight: that window is microseconds.)
    let ancient = false;
    try {
      ancient = Date.now() - statSync(away).mtimeMs > 3 * LOCK_STALE_MS;
    } catch {
      /* gone */
    }
    if (old && ((now !== undefined && now === seen) || (now === undefined && seen === undefined && ancient))) {
      rmSync(away, { recursive: true, force: true });
      return;
    }
    try {
      renameSync(away, lock);
    } catch {
      // A new holder exists: `away` stays; sweepAway() deletes it later, once it is old.
    }
  } catch {
    /* released or broken by someone else meanwhile */
  }
}

/** Run `fn` holding the `.lock` directory in `dir`; undefined when the lock could not be had in time. Throws on filesystem errors. */
export async function locked<T>(dir: string, id: string, fn: () => T, waitMs: number = LOCK_WAIT_MS): Promise<T | undefined> {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  const token = `${process.pid}:${id}:${randomUUID()}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(join(lock, "owner"), token);
      } catch (we) {
        rmSync(lock, { recursive: true, force: true });
        throw we;
      }
      break;
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
      breakStale(lock);
      sweepAway(dir);
      if (Date.now() > until) return undefined;
      await sleep(5);
    }
  }
  try {
    return fn();
  } finally {
    // Only a lock that is still ours (it may have been judged stale and replaced).
    if (ownerOf(lock) === token) rmSync(lock, { recursive: true, force: true });
  }
}
