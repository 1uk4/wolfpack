/**
 * Write lock for a wolf's observation pool (`<den>/.memory/pool/observations.jsonl`).
 * Appends (the unified extension, in wolfd or pi) and read-modify-writes (consolidation settle) take it,
 * so an append can't land between a rewrite's read and write and vanish.
 * Cross-process: `pool.lock` is created with O_EXCL; a lock whose mtime is older than `staleMs`
 * (a crashed holder) is stolen. Keep sections short: no model calls inside.
 */
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
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
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > staleMs) await unlink(lock);
      } catch { /* released or stolen meanwhile */ }
      if (Date.now() > deadline) throw new Error(`pool lock busy: ${lock}`);
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    try { await unlink(lock); } catch { /* already gone */ }
  }
}
