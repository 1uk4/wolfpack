/**
 * The KB write lock: one writer at a time for anything that changes entries,
 * sections or the ledger (sweep, reorg, rebuild).
 *
 * Two layers:
 *   - in-process: Dewey can start several writers in one process (e.g. two
 *     kb_reorg tool calls in parallel); they wait for each other.
 *   - on disk: `<denLocal>/sweep.lock` holds { pid, at } so other processes
 *     (the admin CLI) see it. A lock already held by THIS process's pid was
 *     taken by an outer caller (the CLI takes it before calling sweep/reorg),
 *     so a nested call proceeds without taking or releasing it.
 * A lock whose owner is dead, or older than LOCK_STALE_MS, is reclaimed.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KbRoots } from "../shared/index.js";

const LOCK_STALE_MS = 30 * 60_000;
const POLL_MS = 500;

/** Lock files this process holds through withKbLock. */
const heldHere = new Set<string>();

export class KbLockBusy extends Error {}

export function kbLockFile(roots: KbRoots): string {
  return join(roots.denLocal, "sweep.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user (e.g. a root CLI
    // run seen from the wolf's sweep). Only ESRCH means it is gone.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** "owned": we wrote the lock. "outer": this pid already holds it. null: busy. */
function tryAcquire(file: string): "owned" | "outer" | null {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    try {
      const info = JSON.parse(readFileSync(file, "utf-8")) as { pid: number; at: number };
      if (info.pid === process.pid) return "outer";
      if (pidAlive(info.pid) && Date.now() - info.at < LOCK_STALE_MS) return null;
    } catch {
      /* unreadable lock: treat as stale */
    }
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return "owned";
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
  try {
    return await fn();
  } finally {
    heldHere.delete(file);
    if (got === "owned") {
      try {
        unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
  }
}
