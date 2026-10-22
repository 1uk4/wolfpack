/**
 * The KB write lock: one writer at a time for anything that changes entries,
 * sections or the ledger (sweep, reorg, rebuild).
 *
 * Two layers:
 *   - in-process: Dewey can start several writers in one process (e.g. two
 *     kb_reorg tool calls in parallel); they wait for each other.
 *   - on disk: `<denLocal>/sweep.lock` holds { pid, at } so other processes
 *     (the admin CLI) see it. It is created with O_EXCL, so two processes
 *     can't both win, and the holder touches its mtime every
 *     LOCK_HEARTBEAT_MS. A lock already held by THIS process's pid was taken
 *     by an outer caller (the CLI takes it before calling sweep/reorg), so a
 *     nested call proceeds without taking or releasing it.
 * A lock whose owner is dead, or whose heartbeat (mtime) is older than
 * LOCK_STALE_MS, is reclaimed. A long reorg keeps beating, so it isn't stolen.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KbRoots } from "../shared/index.js";

export const LOCK_STALE_MS = 30 * 60_000;
export const LOCK_HEARTBEAT_MS = 60_000;
/** A lock file that exists but can't be parsed is probably mid-creation; give it this long. */
const LOCK_UNREADABLE_GRACE_MS = 10_000;
const POLL_MS = 500;

/** Lock files this process holds through withKbLock. */
const heldHere = new Set<string>();

export class KbLockBusy extends Error {}

export function kbLockFile(roots: KbRoots): string {
  return join(roots.denLocal, "sweep.lock");
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user (e.g. a root CLI
    // run seen from the wolf's sweep). Only ESRCH means it is gone.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Create the lock file exclusively. False if it already exists. */
function createExclusive(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
    throw err;
  }
  closeSync(fd);
  return true;
}

type LockState = { kind: "outer" } | { kind: "busy" } | { kind: "stale"; raw: string } | { kind: "gone" };

/** Judge an existing lock file. The stale age is the heartbeat age (mtime), not the acquisition time. */
function inspect(file: string): LockState {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(file, "utf-8");
    mtimeMs = statSync(file).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "gone" };
    throw err;
  }
  const age = Date.now() - mtimeMs;
  try {
    const info = JSON.parse(raw) as { pid: number };
    if (!Number.isInteger(info.pid)) throw new Error("bad pid");
    if (info.pid === process.pid) return { kind: "outer" };
    if (pidAlive(info.pid) && age < LOCK_STALE_MS) return { kind: "busy" };
  } catch {
    // Unreadable lock: possibly another process between open and write.
    if (age < LOCK_UNREADABLE_GRACE_MS) return { kind: "busy" };
  }
  return { kind: "stale", raw };
}

/** "owned": we created the lock. "outer": this pid already holds it. null: busy. */
function tryAcquire(file: string): "owned" | "outer" | null {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createExclusive(file)) return "owned";
    const state = inspect(file);
    if (state.kind === "outer") return "outer";
    if (state.kind === "busy") return null;
    if (state.kind === "stale") {
      // Re-read just before removing so we never delete a lock someone else
      // reclaimed and re-created since we looked.
      try {
        if (readFileSync(file, "utf-8") === state.raw) unlinkSync(file);
      } catch {
        /* gone already */
      }
    }
  }
  return null; // lost the reclaim race to another process
}

/** Refresh the lock's mtime while held. The timer is unref'd, so it never keeps the process alive. */
function startHeartbeat(file: string): () => void {
  const timer = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(file, t, t);
    } catch (err) {
      console.warn(`kb lock: heartbeat failed for ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Take the on-disk lock without waiting, for callers that can't be wrapped in
 * withKbLock (the admin CLI). Returns a release function, or null if another
 * process holds it. If this pid already holds it, returns a no-op release.
 */
export function acquireKbLock(roots: KbRoots): (() => void) | null {
  const file = kbLockFile(roots);
  const got = tryAcquire(file);
  if (!got) return null;
  if (got === "outer") return () => {};
  const stop = startHeartbeat(file);
  return () => {
    stop();
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}

/**
 * Remove the lock file if THIS process owns it. For signal handlers, where the
 * try/finally of withKbLock never runs. Never touches another process's lock.
 */
export function releaseOwnedLock(roots: KbRoots): void {
  const file = kbLockFile(roots);
  try {
    const info = JSON.parse(readFileSync(file, "utf-8")) as { pid?: number };
    if (info.pid === process.pid) unlinkSync(file);
  } catch {
    /* no lock, unreadable, or already gone */
  }
}

/**
 * Run `fn` holding the KB write lock. Waits up to `waitMs` (default 0) for
 * another writer to finish, then throws KbLockBusy.
 */
export async function withKbLock<T>(
  roots: KbRoots,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {}
): Promise<T> {
  const file = kbLockFile(roots);
  const deadline = Date.now() + (opts.waitMs ?? 0);
  let got: "owned" | "outer" | null = null;
  for (;;) {
    // Check and take in one synchronous step, so two async callers in this
    // process can't both get through.
    if (!heldHere.has(file)) got = tryAcquire(file);
    if (got) break;
    if (Date.now() >= deadline) throw new KbLockBusy("the KB is busy (another sweep, reorg or rebuild is running)");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  heldHere.add(file);
  const stopHeartbeat = got === "owned" ? startHeartbeat(file) : undefined;
  try {
    return await fn();
  } finally {
    heldHere.delete(file);
    stopHeartbeat?.();
    if (got === "owned") {
      try {
        unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
  }
}
