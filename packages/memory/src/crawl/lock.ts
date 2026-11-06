/**
 * File locks for the crawl service (`.reserve-*` start reservations, `<runDir>/release.lock`).
 *
 *  - Published atomically: the full body (pid, host, boot, time, owner token) is written to a unique tmp file and `link()`ed to the
 *    lock path; EEXIST = held. There is no empty-then-write window.
 *  - Staleness: on the same host a dead pid or a different (known) boot id is stale at once; otherwise (and always on another host,
 *    where a pid cannot be checked) only age beyond `maxAgeMs` makes a lock stale. Unreadable content is stale only once its mtime
 *    is older than UNREADABLE_GRACE_MS (it may be mid-write on a filesystem without atomic link).
 *  - Takeover is serialised by a second lock (`<lock>.takeover`).
 *  - Release deletes the file only if its body still carries our token (a lock taken over from us is not ours to delete).
 *  - A holder keeps its lock fresh with refreshLock() (heartbeat).
 *  - Takeover renames the stale file ASIDE and compares the renamed copy with what was judged stale; if it changed (the owner
 *    refreshed it) it is put back and the taker backs off. refreshLock checks the token first, so a lock taken over is not revived.
 *    (Residual window: a refresh landing between the taker's rename and its publish; only reachable for a lock already older than
 *    its max age, i.e. an owner that missed its whole refresh budget.) The crashed-takeover guard is removed the same way.
 *  - Hosts whose boot id is "unknown" (no /proc boot_id, no sysctl) cannot detect a reboot: after a reboot with pid reuse a
 *    lock can block for up to its max age (reservation: staleMs; release.lock: RELEASE_LOCK_MAX_AGE_MS).
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
  /** Test hook: runs under the takeover guard, just before the stale file is renamed aside. */
  beforeTake?: (file: string) => void;
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

/**
 * Remove `file` only if it still holds exactly `expected` (what the caller judged stale). The file is renamed ASIDE first, so a
 * concurrent writer that replaced it (an owner's refresh, another taker) is detected from the renamed copy and put back, never
 * deleted. true = gone (removed, or already absent); false = it had changed and was restored.
 */
function takeAside(file: string, expected: string | undefined, token: string): boolean {
  const aside = `${file}.stale.${token}.${++seq}`;
  try {
    renameSync(file, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  if (read(aside) === expected) {
    rmSync(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, file); // put it back (EEXIST: someone published a new one meanwhile; theirs stands)
  } catch {
    /* nothing more to do */
  }
  rmSync(aside, { force: true });
  return false;
}

export function acquireLock(file: string, maxAgeMs: number, env: LockEnv): HeldLock | undefined {
  const token = randomBytes(8).toString("hex");
  const body = JSON.stringify({ pid: env.pid, host: env.host, boot: env.boot, at: env.now(), token } satisfies LockBody);
  if (publish(file, body)) return { file, token };
  const seen = read(file);
  if (!judgeStale(file, seen, maxAgeMs, env)) return undefined;
  env.afterJudge?.(file);
  // Serialised takeover: a second lock guards it.
  const guard = `${file}.takeover`;
  const guardBody = JSON.stringify({ pid: env.pid, host: env.host, boot: env.boot, at: env.now(), token });
  if (!publish(guard, guardBody)) {
    // A takeover is in progress, or crashed. A guard older than a few seconds is a crashed one: remove it with the same
    // rename-aside + compare (only if unchanged) and try once; otherwise this is a clash and a later attempt retries.
    const seenGuard = read(guard);
    let old = false;
    try {
      old = env.now() - statSync(guard).mtimeMs > TAKEOVER_MAX_AGE_MS;
    } catch {
      /* gone */
    }
    if (!old) return undefined;
    env.afterJudge?.(guard);
    if (!takeAside(guard, seenGuard, token)) return undefined;
    if (!publish(guard, guardBody)) return undefined;
  }
  try {
    env.beforeTake?.(file);
    // Rename aside and compare with what was judged stale: an owner that refreshed meanwhile keeps its lock.
    if (!takeAside(file, seen, token)) return undefined;
    return publish(file, body) ? { file, token } : undefined;
  } finally {
    // our own guard only (token check), removed aside-style so a successor's guard is never deleted
    if (parse(read(guard))?.token === token) takeAside(guard, guardBody, token);
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
