/**
 * File locks for the crawl service (`.reserve-*` start reservations, `<runDir>/release.lock`).
 *
 *  - Published atomically: the full body (pid, host, boot, time, owner token) is written to a unique tmp file and `link()`ed to the
 *    lock path; EEXIST = held. There is no empty-then-write window.
 *  - Staleness: on the same host a dead pid or a different (known) boot id is stale at once; otherwise (and always on another host,
 *    where a pid cannot be checked) only age beyond `maxAgeMs` makes a lock stale. Unreadable content is stale only once its mtime
 *    is older than UNREADABLE_GRACE_MS (it may be mid-write on a filesystem without atomic link).
 *  - Takeover is serialised by a second lock (`<lock>.takeover`): the stale file is re-read under it and removed only if it is still
 *    exactly what was judged stale.
 *  - Release deletes the file only if its body still carries our token (a lock taken over from us is not ours to delete).
 *  - A holder keeps its lock fresh with refreshLock() (heartbeat).
 */
import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

export const UNREADABLE_GRACE_MS = 5000;
const TAKEOVER_MAX_AGE_MS = 10_000;

export interface LockEnv {
  pid: number;
  host: string;
  boot: string;
  isAlive: (pid: number) => boolean;
  now: () => number;
  /** Test hook: runs after a lock was judged stale, before the takeover. */
  afterJudge?: (file: string) => void;
}
export interface LockBody {
  pid: number;
  host: string;
  boot: string;
  at: number;
  token: string;
}
export interface HeldLock {
  file: string;
  token: string;
}

let seq = 0;
const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
};
const parse = (raw: string | undefined): LockBody | undefined => {
  if (raw === undefined) return undefined;
  try {
    const l = JSON.parse(raw) as Partial<LockBody>;
    return l && typeof l === "object" && typeof l.pid === "number" && typeof l.host === "string" ? (l as LockBody) : undefined;
  } catch {
    return undefined;
  }
};

/** Two boot ids differ only when both are known and not equal ("unknown" never proves a difference). */
export const bootsDiffer = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && a !== "unknown" && b !== "unknown" && a !== b;

/** Publish `body` at `file` atomically; false = it exists. */
function publish(file: string, body: string): boolean {
  const tmp = `${file}.${process.pid}.${++seq}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, body);
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Is the lock content `raw` (read from `file`) stale for this process? */
function judgeStale(file: string, raw: string | undefined, maxAgeMs: number, env: LockEnv): boolean {
  if (raw === undefined) return true; // vanished
  const l = parse(raw);
  if (!l) {
    try {
      return env.now() - statSync(file).mtimeMs > UNREADABLE_GRACE_MS;
    } catch {
      return true;
    }
  }
  if (l.host === env.host) {
    if (bootsDiffer(l.boot, env.boot)) return true;
    if (!env.isAlive(l.pid)) return true;
  }
  return env.now() - (l.at ?? 0) > maxAgeMs;
}

/** True when `file` exists and is not stale (someone holds it). */
export function lockHeld(file: string, maxAgeMs: number, env: LockEnv): boolean {
  const raw = read(file);
  return raw !== undefined && !judgeStale(file, raw, maxAgeMs, env);
}

export function acquireLock(file: string, maxAgeMs: number, env: LockEnv): HeldLock | undefined {
  const token = randomBytes(8).toString("hex");
  const body = JSON.stringify({ pid: env.pid, host: env.host, boot: env.boot, at: env.now(), token } satisfies LockBody);
  if (publish(file, body)) return { file, token };
  const seen = read(file);
  if (!judgeStale(file, seen, maxAgeMs, env)) return undefined;
  env.afterJudge?.(file);
  // Serialised takeover.
  const guard = `${file}.takeover`;
  const guardBody = JSON.stringify({ pid: env.pid, host: env.host, boot: env.boot, at: env.now(), token });
  if (!publish(guard, guardBody)) {
    // someone is taking over; a takeover file older than a few seconds is a crashed takeover
    let old = false;
    try {
      old = env.now() - statSync(guard).mtimeMs > TAKEOVER_MAX_AGE_MS;
    } catch {
      /* gone */
    }
    if (!old) return undefined;
    rmSync(guard, { force: true });
    if (!publish(guard, guardBody)) return undefined;
  }
  try {
    const again = read(file);
    if (again !== seen) {
      // changed since we judged it (another process took over, or the owner refreshed): re-judge what is there now
      if (again !== undefined && !judgeStale(file, again, maxAgeMs, env)) return undefined;
      if (again !== undefined && again !== seen) return undefined; // do not remove something we did not judge
    }
    rmSync(file, { force: true });
    return publish(file, body) ? { file, token } : undefined;
  } finally {
    if (parse(read(guard))?.token === token) rmSync(guard, { force: true });
  }
}

/** Delete the lock only if it is still ours. */
export function releaseLock(lock: HeldLock): void {
  if (parse(read(lock.file))?.token === lock.token) rmSync(lock.file, { force: true });
}

/** Re-stamp a lock we hold (atomic replace; no-op when it is no longer ours). */
export function refreshLock(lock: HeldLock, env: LockEnv): boolean {
  const cur = parse(read(lock.file));
  if (cur?.token !== lock.token) return false;
  const tmp = `${lock.file}.${process.pid}.${++seq}.refresh.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...cur, at: env.now() } satisfies LockBody));
    renameSync(tmp, lock.file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}
