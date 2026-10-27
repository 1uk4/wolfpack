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
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return code(e) === "EPERM";
  }
}

/** When the process started, as `ps` prints it (stable for the life of the process); undefined if unreadable. */
function startOf(pid: number, cache?: Map<number, string | undefined>): string | undefined {
  if (cache?.has(pid)) return cache.get(pid);
  // Recently read values are reused (acquire runs often; ps is slow). A reused pid within the TTL is the only risk, and slots also check pidAlive.
  const hit = startCache.get(pid);
  let v: string | undefined;
  if (hit && Date.now() - hit.at < START_TTL_MS) v = hit.v;
  else {
    try {
      // C locale and UTC: the same text whatever the user's locale or TZ, so a slot written by one wolfd compares equal in another.
      v = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim() || undefined;
    } catch {
      v = undefined;
    }
    if (startCache.size > 256) startCache.clear();
    startCache.set(pid, { v, at: Date.now() });
  }
  cache?.set(pid, v);
  return v;
}
const START_TTL_MS = 30_000;
const startCache = new Map<number, { v: string | undefined; at: number }>();
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

  private ownerOf(lock: string): string | undefined {
    try {
      return readFileSync(join(lock, "owner"), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Leftover renamed-away locks that are old enough to be certainly dead. */
  private sweepAway(): void {
    try {
      for (const n of readdirSync(this.dir)) {
        if (!n.startsWith(".lock.stale-")) continue;
        try {
          if (Date.now() - statSync(join(this.dir, n)).mtimeMs > 2 * LOCK_STALE_MS) rmSync(join(this.dir, n), { recursive: true, force: true });
        } catch {
          /* gone */
        }
      }
    } catch {
      /* no dir yet */
    }
  }

  /** Break a lock whose holder died: rename it away first (only one breaker wins), then delete it. */
  private breakStale(lock: string): void {
    try {
      if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return;
      const seen = this.ownerOf(lock);
      const away = `${lock}.stale-${randomUUID().slice(0, 8)}`;
      renameSync(lock, away);
      // Delete only with evidence it is the stale lock we looked at: same owner token, and still old.
      // No owner file yet (a taker between mkdir and write), another token, or a fresh mtime: not ours to delete.
      const now = this.ownerOf(away);
      let old = false;
      try {
        old = Date.now() - statSync(away).mtimeMs > LOCK_STALE_MS;
      } catch {
        /* gone */
      }
      // (An ownerless lock older than three stale periods cannot be a write in flight: that window is microseconds.)
      let ancient = false;
      try {
        ancient = Date.now() - statSync(away).mtimeMs > 3 * LOCK_STALE_MS;
      } catch {
        /* gone */
      }
      if (old && ((now !== undefined && now === seen) || (now === undefined && seen === undefined && ancient))) {
        rmSync(away, { recursive: true, force: true });
        return;
      }
      try {
        renameSync(away, lock);
      } catch {
        // A new holder exists: `away` stays; sweepAway() deletes it later, once it is old.
      }
    } catch {
      /* released or broken by someone else meanwhile */
    }
  }

  /** Run `fn` holding the lock; undefined when the lock could not be had in time. Throws on filesystem errors. */
  private async locked<T>(fn: () => T): Promise<T | undefined> {
    mkdirSync(this.dir, { recursive: true });
    const lock = join(this.dir, ".lock");
    const token = `${process.pid}:${this.id}:${randomUUID()}`;
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        try {
          writeFileSync(join(lock, "owner"), token);
        } catch (we) {
          rmSync(lock, { recursive: true, force: true });
          throw we;
        }
        break;
      } catch (e) {
        if (code(e) !== "EEXIST") throw e;
        this.breakStale(lock);
        this.sweepAway();
        if (Date.now() > until) return undefined;
        await sleep(5);
      }
    }
    try {
      return fn();
    } finally {
      // Only a lock that is still ours (it may have been judged stale and replaced).
      if (this.ownerOf(lock) === token) rmSync(lock, { recursive: true, force: true });
    }
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
