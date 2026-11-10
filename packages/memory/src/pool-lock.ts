/**
 * Write lock for a wolf's observation pool (`<den>/.memory/pool/observations.jsonl`).
 * Appends (the unified extension, in wolfd or pi) and read-modify-writes (consolidation settle) take it,
 * so an append can't land between a rewrite's read and write and vanish.
 * Cross-process: `pool.lock` is created with O_EXCL; a lock whose mtime is older than `staleMs`
 * (a crashed holder) is stolen. Keep sections short: no model calls inside.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { poolDir } from "./work-pending.js";

export interface PoolLockOptions {
  /** A lock older than this is taken over (default 30 s). */
  staleMs?: number;
  /** Give up waiting for a held, fresh lock after this long (default 60 s). */
  timeoutMs?: number;
}

export async function withPoolLock<T>(den: string, fn: () => Promise<T> | T, opts: PoolLockOptions = {}): Promise<T> {
  const staleMs = opts.staleMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const dir = poolDir(den);
  const lock = join(dir, "pool.lock");
  await mkdir(dir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  // Unique token in the lock: release removes only our own file, and a steal renames the stale file
  // to a token-named path first (only one waiter's rename succeeds), so a fresh lock is never unlinked.
  const token = `${process.pid}-${randomUUID()}`;
  for (;;) {
    try {
      await writeFile(lock, token, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > staleMs) {
          const stolen = `${lock}.${token}`;
          await rename(lock, stolen);
          // Re-check what we actually took: if another waiter stole first and took a fresh lock between our
          // stat and rename, put it back (link fails if the path is taken again) instead of deleting it.
          if (Date.now() - (await stat(stolen)).mtimeMs <= staleMs) await link(stolen, lock).catch(() => {});
          await unlink(stolen).catch(() => {});
        }
      } catch { /* released or stolen meanwhile */ }
      if (Date.now() > deadline) throw new Error(`pool lock busy: ${lock}`);
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if ((await readFile(lock, "utf-8")) === token) await unlink(lock);
    } catch { /* already gone */ }
  }
}
