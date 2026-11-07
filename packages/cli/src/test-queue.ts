/**
 * The host-wide test queue. Agents' `wolfpack test` runs line up here so only `slots` run at once.
 * One ticket file `<seq>.json` per run in a host-local directory (default `~/.wolfpack/run/test-queue/`), created under
 * the shared mkdir lock with seq = max + 1. A ticket is admitted (waiting -> running) when fewer than `slots` live
 * running tickets exist and it is the lowest live waiting ticket. A ticket is dead, and swept, when its pid is gone or
 * the pid now belongs to another process (the start time differs).
 *
 * Locking rules: the lock is held only for a readdir plus one small write. Liveness (`ps`, kill -0) is judged before
 * taking it, and dead tickets are removed outside it, so a holder never sits on the lock long enough for the stale-lock
 * breaker (5 s) to take it from a live process. A busy lock is "not this poll": waiters retry with jittered backoff.
 * A run whose runner crashed leaves its vitest group behind: the ticket records the group, counts as live while the
 * group lives, and the sweep terminates the orphan (SIGTERM, then SIGKILL on the next pass).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostPidAlive, locked, startOf } from "@wolfpack/engine";

export const DEFAULT_QUEUE_DIR = join(homedir(), ".wolfpack", "run", "test-queue");
export const QUEUE_TIMEOUT_MS = 20 * 60_000;
/** An orphaned vitest group gets SIGTERM, then SIGKILL this long after. */
export const ORPHAN_GRACE_MS = 10_000;

export interface RunInfo {
  wolf: string;
  cwd: string;
  args: string[];
}

export interface Entry extends RunInfo {
  /** Unique per ticket: a seq (and so a file name) can be reused after a release, an id never is. */
  id?: string;
  seq: number;
  pid: number;
  start?: string;
  state: "waiting" | "running";
  enqueuedAt: number;
  startedAt?: number;
  /** The vitest process group of this run, once started (its leader's pid and start time). */
  child?: { pgid: number; start?: string; /** When the orphan was sent SIGTERM (ms): the SIGKILL grace runs from here. */ termAt?: number };
}

export interface Ticket {
  seq: number;
  file: string;
  id: string;
}

export interface WaitStatus {
  /** 1-based place among the waiting runs. */
  position: number;
  ahead: number;
  running: Entry[];
}

export type TurnResult = { admitted: true } | { admitted: false; holders: Entry[] };

export interface QueueOptions {
  dir?: string;
  slots: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Who owns the tickets (default: this process). Lets tests stand in for other processes. */
  identity?: { pid: number; start?: string };
  pollMs?: number;
  /** How long one attempt waits for the lock before the poll is skipped (default 500 ms). */
  lockWaitMs?: number;
  /** A process's start time (default: `ps`). Never called while the lock is held. */
  probe?: (pid: number) => string | undefined;
  /** Where one-line warnings go (default: stderr). */
  warn?: (line: string) => void;
}

const pad = (n: number) => String(n).padStart(8, "0");
const ordinal = (n: number) => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};
const jitter = (ms: number) => Math.round(ms * (0.5 + Math.random()));

/** The line a waiting agent sees: its place and which runs are going. */
export function formatWait(st: WaitStatus, now: number): string {
  const going = st.running.length
    ? st.running.map((r) => `${r.wolf} in ${r.cwd}: wolfpack test ${r.args.join(" ")} (${elapsed(now - (r.startedAt ?? r.enqueuedAt))})`).join("; ")
    : "nothing yet";
  return `Waiting for a test slot: ${ordinal(st.position)} in line (${st.ahead} ahead of you). Running now: ${going}.`;
}

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The caller asked to stop (a signal) while the ticket was being taken. */
export class QueueCancelled extends Error {
  constructor() {
    super("test queue: cancelled");
  }
}

export function openQueue(opts: QueueOptions) {
  const dir = opts.dir ?? DEFAULT_QUEUE_DIR;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const me = opts.identity ?? { pid: process.pid, start: opts.probe ? opts.probe(process.pid) : startOf(process.pid) };
  const lockId = "test-queue";
  const lockWaitMs = opts.lockWaitMs ?? 500;
  /** Tickets this handle has released: they are never written again. */
  const released = new Set<string>();
  const stripFile = ({ file: _f, ...e }: Entry & { file: string }): Entry => e;

  const read = (): Array<Entry & { file: string }> => {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      return [];
    }
    const out: Array<Entry & { file: string }> = [];
    for (const file of names) {
      try {
        const e = JSON.parse(readFileSync(join(dir, file), "utf8")) as Entry;
        if (typeof e.pid === "number" && typeof e.seq === "number") out.push({ ...e, file });
      } catch {
        /* torn write or removed meanwhile */
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  };

  const startTime = (pid: number, cache: Map<number, string | undefined>) => {
    if (!opts.probe) return startOf(pid, cache);
    if (!cache.has(pid)) cache.set(pid, opts.probe(pid));
    return cache.get(pid);
  };

  const runnerAlive = (e: Entry, cache: Map<number, string | undefined>): boolean => {
    if (!hostPidAlive(e.pid)) return false;
    if (!e.start) return true;
    const cur = startTime(e.pid, cache);
    return cur === undefined || cur === e.start;
  };

  /** Temp files left by a writer that died between write and rename; a minute old means it is not a write in flight. */
  const sweepTmp = () => {
    try {
      for (const n of readdirSync(dir)) {
        if (!/^\..*\.tmp$/.test(n)) continue;
        try {
          if (Date.now() - statSync(join(dir, n)).mtimeMs > 60_000) rmSync(join(dir, n), { force: true });
        } catch {
          /* gone */
        }
      }
    } catch {
      /* no dir yet */
    }
  };

  /**
   * The live tickets. NOT under the lock: it runs `ps`. Dead runners' tickets are removed; a dead runner whose vitest
   * group still lives keeps its ticket (it holds CPU) and the group is terminated.
   */
  const sweep = (keep?: string): Array<Entry & { file: string }> => {
    sweepTmp();
    const cache = new Map<number, string | undefined>();
    return read().filter((e) => {
      if (e.file === keep || runnerAlive(e, cache)) return true;
      const g = e.child;
      if (g && groupAlive(g.pgid)) {
        // A group is stopped only when it is certainly ours: the start time recorded at spawn matches its leader's now,
        // or the leader is gone while the group lives (a pid cannot be reissued while its group exists, so the
        // members are the ones we started). No recorded start, or a mismatch (pid reuse): leave it alone and drop
        // the ticket. `ps` failing while the leader lives: unknown, so keep the ticket and look again next poll.
        const leaderAlive = hostPidAlive(g.pgid);
        const cur = leaderAlive ? startTime(g.pgid, cache) : undefined;
        if (!g.start) {
          rmSync(join(dir, e.file), { force: true });
          return false;
        }
        if (leaderAlive && cur === undefined) return true;
        if (leaderAlive && cur !== g.start) {
          rmSync(join(dir, e.file), { force: true });
          return false;
        }
        const t = now();
        try {
          if (g.termAt === undefined) {
            process.kill(-g.pgid, "SIGTERM");
            // Written without the lock, and that is safe: the ticket's owner is dead, so nobody else writes this file
            // except another sweeper doing the same thing at once (both write a near-identical termAt, via an atomic
            // rename, so a reader never sees a torn file). The worst case is a second SIGTERM, which is harmless.
            if (existsSync(join(dir, e.file))) writeTicket(e.file, { ...stripFile(e), child: { ...g, termAt: t } });
          } else if (t - g.termAt >= ORPHAN_GRACE_MS) process.kill(-g.pgid, "SIGKILL");
        } catch {
          /* gone */
        }
        return true;
      }
      rmSync(join(dir, e.file), { force: true });
      return false;
    });
  };

  /** One attempt under the lock; undefined = busy (retry later). Throws only on real filesystem errors. */
  const tryLocked = async <T>(fn: () => T): Promise<{ v: T } | undefined> => locked(dir, lockId, () => ({ v: fn() }), lockWaitMs);

  const status = (t: Ticket): WaitStatus => {
    const all = sweep(t.file);
    const waiting = all.filter((e) => e.state === "waiting");
    const position = waiting.filter((e) => e.seq <= t.seq).length;
    return { position, ahead: Math.max(0, position - 1), running: all.filter((e) => e.state === "running") };
  };

  /** Delete the ticket file, but only if it is still this ticket (the name may have been reused). */
  const rmOwn = (t: Ticket) => {
    const e = read().find((x) => x.file === t.file);
    if (e && e.id === t.id) rmSync(join(dir, t.file), { force: true });
  };

  /** Replace a ticket file atomically (readers never see a torn write). */
  const writeTicket = (file: string, entry: Entry) => {
    const tmp = join(dir, `.${file}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, join(dir, file));
  };

  return {
    dir,

    async enqueue(run: RunInfo, cancelled?: () => boolean): Promise<Ticket> {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (cancelled?.()) throw new QueueCancelled();
        const r = await tryLocked(() => {
          const seq = read().reduce((m, e) => Math.max(m, e.seq), 0) + 1;
          const file = `${pad(seq)}.json`;
          const id = randomUUID();
          const entry: Entry = { id, seq, pid: me.pid, ...(me.start ? { start: me.start } : {}), state: "waiting", enqueuedAt: now(), ...run };
          mkdirSync(dir, { recursive: true });
          writeTicket(file, entry);
          return { seq, file, id };
        });
        if (r) return r.v;
        await sleep(jitter(100));
      }
      throw new Error("test queue: the lock is busy (another wolfpack test is holding it); try again in a moment");
    },

    status,

    /** Wait until admitted; on timeout the ticket is removed and the holders are reported. */
    async waitTurn(t: Ticket, o: { timeoutMs: number; onWait?: (st: WaitStatus) => void }): Promise<TurnResult> {
      const deadline = now() + o.timeoutMs;
      for (;;) {
        if (released.has(t.id)) throw new QueueCancelled();
        sweep(t.file); // dead tickets go first, outside the lock
        const verdict = await tryLocked((): TurnResult | undefined => {
          if (released.has(t.id)) throw new QueueCancelled();
          const all = read();
          const mine = all.find((e) => e.file === t.file && e.id === t.id);
          if (!mine) throw new Error("test queue: the ticket was removed");
          const running = all.filter((e) => e.state === "running");
          const firstWaiting = all.find((e) => e.state === "waiting");
          if (running.length < opts.slots && firstWaiting?.file === t.file) {
            const { file: _f, ...entry } = mine;
            writeTicket(t.file, { ...entry, state: "running", startedAt: now() });
            return { admitted: true };
          }
          if (now() >= deadline) {
            rmOwn(t);
            return { admitted: false, holders: running };
          }
          return undefined;
        });
        // (a busy lock is "not this poll": fall through to the sleep and retry)
        if (verdict?.v) return verdict.v;
        o.onWait?.(status(t));
        await sleep(jitter(opts.pollMs ?? 1000));
      }
    },

    /**
     * Record the run's vitest process group and its start time (read fresh, bypassing the TTL cache), so a crashed
     * runner's orphan can be found and stopped, and only ever the right process. Without a start the sweep never kills.
     */
    async setChild(t: Ticket, child: { pgid: number; start?: string }): Promise<void> {
      const start = child.start ?? (opts.probe ? opts.probe(child.pgid) : startOf(child.pgid, undefined, true));
      for (let attempt = 0; attempt < 3; attempt++) {
        const done = await tryLocked(() => {
          if (released.has(t.id)) return;
          const mine = read().find((e) => e.file === t.file && e.id === t.id);
          if (!mine) return;
          writeTicket(t.file, { ...stripFile(mine), child: { pgid: child.pgid, ...(start ? { start } : {}) } });
        });
        if (done) return;
        await sleep(jitter(50));
      }
      (opts.warn ?? ((l: string) => console.error(l)))("test queue: could not record the vitest process; if this run crashes, its vitest may keep running");
    },

    /** Give the ticket up. It is deleted under the lock and never written again by this handle. */
    async release(t: Ticket): Promise<void> {
      released.add(t.id);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await tryLocked(() => rmOwn(t))) return;
        await sleep(jitter(50));
      }
      rmOwn(t); // the lock is stuck: a leftover ticket would block the line
    },

    /** Live tickets in line order. */
    snapshot(): Entry[] {
      return sweep().map(({ file: _f, ...e }) => e);
    },
  };
}
