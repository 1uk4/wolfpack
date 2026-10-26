/**
 * Exactly ONE local work server writes a sandbox's ledger copy. Two writers appending to the same JSONL would
 * interleave and corrupt it, so the rule is enforced on disk, not by convention:
 *
 *   <root>/run/work-server.lock   exclusive-create (`wx`) lock holding the owner's pid; a live second holder fails loudly
 *   <root>/run/work-server.json   run file {pid,url,token}: how every other wolf ATTACHES to the owner's server
 *
 * The lock is taken atomically (a complete temp file is link()ed into place), an unparseable lock counts as HELD until it
 * is old, and a dead owner's lock is taken over by rename-then-verify so a contender can never delete someone else's live lock.
 *
 * The owner is workerd when it supervises the wolves (it outlives them), else the first wolf to start. A lock whose pid
 * is dead is stale and is taken over.
 */
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { sandboxPaths } from "./layout.js";
import { SandboxError } from "./resolve.js";

export interface WorkServerRunFile {
  pid: number;
  url: string;
  token: string;
  startedAt: string;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The run file of a LIVE owner, or undefined (absent, unreadable, or its pid is dead). */
export function readWorkServerRunFile(root: string): WorkServerRunFile | undefined {
  const f = readJson<WorkServerRunFile>(sandboxPaths(resolve(root)).workServerFile);
  if (!f || typeof f.url !== "string" || typeof f.token !== "string" || !pidAlive(f.pid)) return undefined;
  return f;
}

export interface WriterLock {
  /** Publish the server's address for attachers (mode 0600: it carries the token). */
  publish(info: { url: string; token: string }): void;
  /** Drop the run file and the lock (only ours). */
  release(): void;
}

/** An unparseable lock (torn write by a crashed or slow owner) is held until it is this old. */
export const TORN_LOCK_MAX_AGE_MS = 60_000;

/** The pid of a LIVE lock holder (lock file or run file), or undefined. Used to re-check right before swapping a ledger. */
export function liveWorkWriterPid(root: string): number | undefined {
  const p = sandboxPaths(resolve(root));
  const run = readWorkServerRunFile(root);
  if (run) return run.pid;
  const held = readJson<{ pid?: number }>(p.workServerLock);
  if (held?.pid !== undefined && pidAlive(held.pid)) return held.pid;
  return undefined;
}

type LockState = { kind: "held"; pid?: number } | { kind: "stale"; ino: number };

function lockState(file: string): LockState | undefined {
  let st;
  try {
    st = statSync(file);
  } catch {
    return undefined; // gone
  }
  const held = readJson<{ pid?: number }>(file);
  if (held && typeof held.pid === "number") return pidAlive(held.pid) ? { kind: "held", pid: held.pid } : { kind: "stale", ino: st.ino };
  // unparseable (torn): held unless old
  return Date.now() - st.mtimeMs > TORN_LOCK_MAX_AGE_MS ? { kind: "stale", ino: st.ino } : { kind: "held" };
}

/**
 * Take the writer lock for the sandbox at `root`. Throws a SandboxError when a live process already holds it.
 * `pid` is injectable for tests.
 */
export function acquireWorkWriterLock(root: string, pid: number = process.pid): WriterLock {
  const p = sandboxPaths(resolve(root));
  mkdirSync(p.runDir, { recursive: true });
  const tmp = `${p.workServerLock}.${pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(tmp, p.workServerLock); // atomic: the lock appears complete, or not at all
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const state = lockState(p.workServerLock);
      if (state?.kind === "held") {
        throw new SandboxError(`the work ledger in ${root} already has a writer (${state.pid ? `pid ${state.pid}` : "unreadable lock, still fresh"}, ${p.workServerLock}); a second work server would corrupt it. Attach to it or stop it first`);
      }
      if (attempt > 3) throw new SandboxError(`cannot take the work-writer lock ${p.workServerLock}`);
      if (state?.kind === "stale") takeOverStale(p.workServerLock, state.ino);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return {
    publish(info) {
      const body: WorkServerRunFile = { pid, url: info.url, token: info.token, startedAt: new Date().toISOString() };
      writeFileSync(p.workServerFile, JSON.stringify(body) + "\n", { mode: 0o600 });
      chmodSync(p.workServerFile, 0o600);
    },
    release() {
      const run = readJson<{ pid?: number }>(p.workServerFile);
      if (run?.pid === pid) rmSync(p.workServerFile, { force: true });
      const held = readJson<{ pid?: number }>(p.workServerLock);
      if (held?.pid === pid) rmSync(p.workServerLock, { force: true });
    },
  };
}

/**
 * Remove a stale lock without ever deleting a live one: rename it away (atomic, so one contender wins the file), then
 * verify what we moved is the very inode we judged stale. If another contender already replaced it with a live lock, put
 * that lock back (link fails if yet another took the path; then ours is dropped and the loop reports who holds it).
 */
function takeOverStale(lock: string, staleIno: number): void {
  const moved = `${lock}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lock, moved);
  } catch {
    return; // someone else moved it first
  }
  try {
    if (statSync(moved).ino === staleIno) return; // it was the stale one: gone for good (removed below)
    try {
      linkSync(moved, lock); // a live lock slipped in between: restore it
    } catch { /* path re-taken; the retry loop reports the holder */ }
  } finally {
    if (statSync(moved, { throwIfNoEntry: false })) rmSync(moved, { force: true });
  }
}
