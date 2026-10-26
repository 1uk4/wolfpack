/**
 * Exactly ONE local work server writes a sandbox's ledger copy. Two writers appending to the same JSONL would
 * interleave and corrupt it, so the rule is enforced on disk, not by convention:
 *
 *   <root>/run/work-server.lock   exclusive-create (`wx`) lock holding the owner's pid; a live second holder fails loudly
 *   <root>/run/work-server.json   run file {pid,url,token}: how every other wolf ATTACHES to the owner's server
 *
 * The owner is workerd when it supervises the wolves (it outlives them), else the first wolf to start. A lock whose pid
 * is dead is stale and is taken over.
 */
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Take the writer lock for the sandbox at `root`. Throws a SandboxError when a live process already holds it.
 * `pid` is injectable for tests.
 */
export function acquireWorkWriterLock(root: string, pid: number = process.pid): WriterLock {
  const p = sandboxPaths(resolve(root));
  mkdirSync(p.runDir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(p.workServerLock, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readJson<{ pid?: number }>(p.workServerLock);
      if (held?.pid !== undefined && pidAlive(held.pid)) {
        throw new SandboxError(`the work ledger in ${root} already has a writer (pid ${held.pid}, ${p.workServerLock}); a second work server would corrupt it. Attach to it or stop it first`);
      }
      if (attempt > 0) throw new SandboxError(`cannot take the work-writer lock ${p.workServerLock}`);
      rmSync(p.workServerLock, { force: true }); // stale (dead owner) or torn: take over
    }
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
