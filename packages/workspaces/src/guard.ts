import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type AcquireResult = { ok: true } | { ok: false; owner: string };

function key(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** In-memory registry of active writers, keyed by the realpath of the git working dir. */
export class WriterGuard {
  private readonly holders = new Map<string, string>();

  /** Re-acquiring as the same owner succeeds; another owner holding the dir fails with that owner's id. */
  acquire(dir: string, ownerId: string): AcquireResult {
    const k = key(dir);
    const held = this.holders.get(k);
    if (held !== undefined && held !== ownerId) return { ok: false, owner: held };
    this.holders.set(k, ownerId);
    return { ok: true };
  }

  /** Release only if ownerId holds it. Returns whether something was released. */
  release(dir: string, ownerId: string): boolean {
    const k = key(dir);
    if (this.holders.get(k) !== ownerId) return false;
    this.holders.delete(k);
    return true;
  }

  holder(dir: string): string | undefined {
    return this.holders.get(key(dir));
  }
}
