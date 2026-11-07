/**
 * The host-wide subagent slots. One wolfd runs per wolf, so the per-host cap is shared between processes through a
 * directory (default `~/.wolfpack/run/subagent-slots/`): one file `<wolf>~<child>.json` per running child, holding the
 * owner's pid and process start time. Taking a slot is check-then-create under a `mkdir` lock (atomic everywhere, no
 * native deps).
 *
 * The directory MUST be host-local (never synced or network-mounted): liveness is judged by pid.
 * A slot is stale, does not count and is swept when its pid is gone or the pid now belongs to another process (the start
 * time differs: pid reuse). Every filesystem failure (unwritable or full directory) is reported through `onError` and
 * treated as "no slot available", never thrown at the caller.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { breakStale, hostPidAlive as pidAlive, locked, sweepAway, LOCK_STALE_MS, startOf } from "@wolfpack/engine";

export const DEFAULT_HOST_MAX = 6;

interface Slot {
  pid: number;
  /** Start time of the process (`ps lstart`); absent when it could not be read. */
  start?: string;
  /** The pool instance that wrote it. */
  pool?: string;
  wolf: string;
  child: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const OWN_START = startOf(process.pid);

/** Pools of this process that are open: a slot of this process written by a pool that is not here is a leftover. */
const openPools = new Set<string>();

export class SlotPool {
  private readonly id = randomUUID();

  constructor(
    readonly dir: string,
    readonly hostMax: number,
    private readonly wolf: string,
    private readonly onError: (e: unknown) => void = () => {},
  ) {
    openPools.add(this.id);
  }

  close(): void {
    openPools.delete(this.id);
  }

  private file(child: string): string {
    return join(this.dir, `${safe(this.wolf)}~${safe(child)}.json`);
  }

  private slots(): Array<Slot & { name: string }> {
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
        if (typeof s.pid === "number") out.push({ ...s, name });
      } catch {
        // Unreadable (a torn write, or removed meanwhile): swept once it is old enough to not be a write in flight.
        try {
          if (Date.now() - statSync(join(this.dir, name)).mtimeMs > LOCK_STALE_MS) rmSync(join(this.dir, name), { force: true });
        } catch {
          /* gone */
        }
      }
    }
    return out;
  }

  private isAlive(s: Slot, cache: Map<number, string | undefined>): boolean {
    if (!pidAlive(s.pid)) return false;
    if (!s.start) return true;
    const now = startOf(s.pid, cache);
    return now === undefined || now === s.start;
  }

  /** The live slots; stale ones are removed on the way. */
  private live(): Array<Slot & { name: string }> {
    const cache = new Map<number, string | undefined>();
    return this.slots().filter((s) => {
      if (this.isAlive(s, cache)) return true;
      rmSync(join(this.dir, s.name), { force: true });
      return false;
    });
  }

  private breakStale(lock: string): void {
    breakStale(lock);
  }

  private sweepAway(): void {
    sweepAway(this.dir);
  }

  /** Run `fn` holding the lock; undefined when the lock could not be had in time. Throws on filesystem errors. */
  private locked<T>(fn: () => T): Promise<T | undefined> {
    return locked(this.dir, this.id, fn);
  }

  private write(child: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(child), JSON.stringify({ pid: process.pid, ...(OWN_START ? { start: OWN_START } : {}), pool: this.id, wolf: this.wolf, child } satisfies Slot));
  }

  /** Take a slot for `child` unless the host is full, the lock is busy, or the directory fails (reported): then false. */
  async tryAcquire(child: string): Promise<boolean> {
    try {
      const r = await this.locked(() => {
        if (this.live().length >= this.hostMax) return false;
        this.write(child);
        return true;
      });
      return r === true;
    } catch (e) {
      this.onError(e);
      return false;
    }
  }

  /**
   * Take a slot regardless of the cap: a child that was already running when wolfd restarted. Retries the lock, then
   * writes its own file without it (the lock only guards the cap check). False only if the file could not be written.
   */
  async claim(child: string): Promise<boolean> {
    try {
      for (let i = 0; i < 3; i++) {
        const done = await this.locked(() => {
          this.write(child);
          return true;
        });
        if (done) return true;
      }
      this.write(child);
      return true;
    } catch (e) {
      this.onError(e);
      return false;
    }
  }

  release(child: string): void {
    try {
      rmSync(this.file(child), { force: true });
    } catch (e) {
      this.onError(e);
    }
  }

  /**
   * This wolf's slots written by a process that is gone, or by an earlier pool of THIS process (a restart in-process).
   * A live second wolfd's slots are never touched, whatever its name.
   */
  dropOwn(): void {
    const cache = new Map<number, string | undefined>();
    for (const s of this.slots()) {
      if (s.wolf !== this.wolf) continue;
      const leftover = s.pid === process.pid && (!s.start || s.start === OWN_START) && s.pool !== undefined && !openPools.has(s.pool);
      if (leftover || !this.isAlive(s, cache)) rmSync(join(this.dir, s.name), { force: true });
    }
  }

  count(): number {
    return this.live().length;
  }
}
