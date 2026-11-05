/**
 * curator-lease — who sweeps this KB: the hub's curator or a wolf-side sweep (harness timer / kb CLI), never both.
 *
 * `<laneDir>/.sweep-lease` holds { owner: "hub" | "wolf", pid, host, at }. It is created with O_EXCL and its mtime is the
 * heartbeat. A lease is STALE after `staleMs` without a heartbeat (default 2x the tick budget), or at once when its pid is dead
 * on the same host. A dotfile in a lane directory is never read as a contribution (intake lists wolf DIRECTORIES and `*.md`).
 *
 * The lease is advisory and complements the KB lock (lock.ts), which only serialises writers inside one denLocal.
 * Both sweeps run through runSweepTick, which takes a wolf lease and skips the tick while a fresh hub lease exists; the hub's
 * curator takes the hub lease and refuses to run while a fresh wolf lease exists.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { SWEEP } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";

export const LEASE_FILE = ".sweep-lease";
/** The tick budget: the run budget plus the embed slack tick.ts allows. */
export const TICK_BUDGET_MS = SWEEP.runBudgetMs + SWEEP.embedTimeoutMs * 4;
export const LEASE_STALE_MS = 2 * TICK_BUDGET_MS;
const HEARTBEAT_MS = 30_000;

export type LeaseOwner = "hub" | "wolf";
export interface Lease {
  owner: LeaseOwner;
  pid: number;
  host: string;
  at: string;
}
export interface LeaseOptions {
  staleMs?: number;
  /** Test seams. */
  now?: () => number;
  host?: string;
  pidAlive?: (pid: number) => boolean;
}

export const leaseFile = (dir: string) => join(dir, LEASE_FILE);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lease in `dir`, fresh or not (null: none, or unreadable). */
export function readLease(dir: string): { lease: Lease; mtimeMs: number } | null {
  try {
    const lease = JSON.parse(readFileSync(leaseFile(dir), "utf-8")) as Lease;
    if ((lease.owner !== "hub" && lease.owner !== "wolf") || !Number.isInteger(lease.pid)) return null;
    return { lease, mtimeMs: statSync(leaseFile(dir)).mtimeMs };
  } catch {
    return null;
  }
}

/** The lease in `dir` when it is fresh (held by a live sweep), else null. */
export function freshLease(dir: string, opts: LeaseOptions = {}): Lease | null {
  const got = readLease(dir);
  if (!got) return null;
  const now = opts.now?.() ?? Date.now();
  if (now - got.mtimeMs >= (opts.staleMs ?? LEASE_STALE_MS)) return null;
  if (got.lease.host === (opts.host ?? hostname()) && !(opts.pidAlive ?? alive)(got.lease.pid)) return null;
  return got.lease;
}

/** The first fresh lease of `owner` (or any owner) across the lane dirs. */
export function freshLeaseIn(dirs: string[], owner?: LeaseOwner, opts: LeaseOptions = {}): Lease | null {
  for (const d of dirs) {
    const l = freshLease(d, opts);
    if (l && (!owner || l.owner === owner)) return l;
  }
  return null;
}

export interface LeaseHandle {
  release(): void;
}

/** Take the lease in every dir. Null (and nothing held) when a fresh lease of another owner, or another live process, holds one. */
export function acquireLease(dirs: string[], owner: LeaseOwner, opts: LeaseOptions = {}): LeaseHandle | null {
  const mine: string[] = [];
  const host = opts.host ?? hostname();
  const body = () => JSON.stringify({ owner, pid: process.pid, host, at: new Date().toISOString() } satisfies Lease);
  const dropAll = () => {
    for (const d of mine) dropIfMine(d, owner);
  };
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    let got = false;
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        const fd = openSync(leaseFile(dir), "wx");
        try {
          writeSync(fd, body());
        } finally {
          closeSync(fd);
        }
        got = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          dropAll();
          throw e;
        }
        const held = freshLease(dir, opts);
        if (held && !(held.pid === process.pid && held.owner === owner)) {
          dropAll();
          return null;
        }
        if (held) return finish(mine.concat(dir), owner, dropAll); // our own lease again (re-entrant)
        try {
          unlinkSync(leaseFile(dir)); // stale: remove and retry the exclusive create
        } catch {
          /* raced */
        }
      }
    }
    if (!got) {
      dropAll();
      return null;
    }
    mine.push(dir);
  }
  return finish(mine, owner, dropAll);
}

function finish(dirs: string[], owner: LeaseOwner, dropAll: () => void): LeaseHandle {
  const beat = setInterval(() => {
    const t = new Date();
    for (const d of dirs) {
      try {
        utimesSync(leaseFile(d), t, t);
      } catch {
        /* gone: the next tick re-acquires */
      }
    }
  }, HEARTBEAT_MS);
  beat.unref();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      for (const d of dirs) dropIfMine(d, owner);
      void dropAll;
    },
  };
}

function dropIfMine(dir: string, owner: LeaseOwner): void {
  const got = readLease(dir);
  if (got && got.lease.pid === process.pid && got.lease.owner === owner) {
    try {
      unlinkSync(leaseFile(dir));
    } catch {
      /* gone */
    }
  }
}

/** The lane dirs a wolf-side sweep of these roots shares with the hub curator. */
export function wolfLeaseDirs(roots: KbRoots): string[] {
  return [join(roots.opsRoot, "inbox"), join(roots.opsRoot, "contributions")];
}
