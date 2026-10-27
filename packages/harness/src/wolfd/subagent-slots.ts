/**
 * The host-wide subagent slots. One wolfd runs per wolf, so the per-host cap is shared between processes through a
 * directory (default `~/.wolfpack/run/subagent-slots/`): one file `<wolf>~<child>.json` per running child, holding the
 * owner's pid. Taking a slot is check-then-create under a `mkdir` lock (atomic everywhere, no native deps). A slot whose
 * pid is gone (the wolfd died without releasing) is stale: it does not count and is swept by the next taker.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_HOST_MAX = 6;

interface Slot {
  pid: number;
  wolf: string;
  child: string;
}

const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SlotPool {
  constructor(
    readonly dir: string,
    readonly hostMax: number,
    private readonly wolf: string,
  ) {}

  private file(child: string): string {
    return join(this.dir, `${safe(this.wolf)}~${safe(child)}.json`);
  }

  /** The live slots; stale and unreadable ones are removed on the way. */
  private live(): Array<Slot & { name: string }> {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: Array<Slot & { name: string }> = [];
    for (const name of names) {
      try {
        const s = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Slot;
        if (typeof s.pid === "number" && alive(s.pid)) out.push({ ...s, name });
        else rmSync(join(this.dir, name), { force: true });
      } catch {
        // Unreadable (a torn write, or removed meanwhile): not a slot. Leave it for the next sweep if it is still there.
        try {
          if (Date.now() - statSync(join(this.dir, name)).mtimeMs > LOCK_STALE_MS) rmSync(join(this.dir, name), { force: true });
        } catch {
          /* gone */
        }
      }
    }
    return out;
  }

  private async locked<T>(fn: () => T): Promise<T | undefined> {
    mkdirSync(this.dir, { recursive: true });
    const lock = join(this.dir, ".lock");
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock); // its holder died
        } catch {
          /* released meanwhile */
        }
        if (Date.now() > until) return undefined;
        await sleep(5);
      }
    }
    try {
      return fn();
    } finally {
      try {
        rmdirSync(lock);
      } catch {
        /* swept as stale by another taker */
      }
    }
  }

  private write(child: string): void {
    writeFileSync(this.file(child), JSON.stringify({ pid: process.pid, wolf: this.wolf, child } satisfies Slot));
  }

  /** Take a slot for `child` unless the host is full (or the lock could not be had: treated as full, the caller retries). */
  async tryAcquire(child: string): Promise<boolean> {
    const r = await this.locked(() => {
      if (this.live().length >= this.hostMax) return false;
      this.write(child);
      return true;
    });
    return r === true;
  }

  /** Take a slot regardless of the cap: a child that was already running when wolfd restarted. */
  async claim(child: string): Promise<void> {
    await this.locked(() => this.write(child));
  }

  release(child: string): void {
    rmSync(this.file(child), { force: true });
  }

  /** This wolf's slots, whoever wrote them: its previous wolfd (one per wolf) is necessarily gone. */
  dropOwn(): void {
    for (const s of this.live()) if (s.wolf === this.wolf) rmSync(join(this.dir, s.name), { force: true });
  }

  count(): number {
    return this.live().length;
  }
}
