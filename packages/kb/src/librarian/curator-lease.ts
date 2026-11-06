/**
 * curator-lease — who sweeps this KB: the hub's curator or a wolf-side sweep (harness timer / kb CLI), never both.
 *
 * `<laneDir>/.sweep-lease` holds { owner: "hub" | "wolf", pid, host, at }. The body is written to a temp file and PUBLISHED with
 * linkSync (atomic; EEXIST = someone holds it), so the lease never appears empty. Its mtime is the heartbeat. A lease is STALE
 * after `staleMs` without a heartbeat (default 2x the tick budget), or at once when its pid is dead on the same host. A lease
 * that cannot be parsed is treated as HELD for UNREADABLE_GRACE_MS after its mtime, then as stale.
 *
 * A stale lease is taken over under a takeover mutex (`.sweep-lease.takeover`, exclusive link, holds pid + nonce), the same
 * pattern as kb-writer.lock in hubd: under the mutex the lease is re-read, and unlinked only if it is still exactly the bytes
 * that were judged stale. A taker that cannot get the mutex backs off (null: "held"); the next tick retries.
 *
 * Re-entry in one process is ref-counted per file: a second acquire by the same owner shares the lease (every dir is still
 * taken), and the file goes away with the last release. A different owner in the same process is refused.
 *
 * LIMITS. Advisory: it excludes the two kinds of SWEEP (runSweepTick with leaseOwner "wolf", and the hub curator). It does NOT
 * cover reorg, rebuild, retire, split-fat or tryRecoverAndRender: those take only the den-local KB lock (lock.ts) and write the
 * KB directly, bypassing hubd's commitKb. Do not run them against a hub-owned KB while the hub is live. Staleness assumes ONE
 * host and ONE clock (mtime vs. Date.now(), and a pid check only on the same hostname); the file must never be synced
 * (Syncthing `.stignore`: `.sweep-lease*`), or a second machine would read a copy of it. A lease left by a crashed hub with a
 * different live pid or another hostname blocks the next start until it is stale (2x the tick budget) or removed by hand.
 * Leftovers: a crash can leave `.sweep-lease.<pid>.<hex>` / `.sweep-lease.takeover.<pid>.<hex>` temp files (and a stale `.sweep-lease.takeover`) in the lane dir; they are harmless
 * (never read as contributions), safe to delete, and the takeover mutex clears itself after MUTEX_STALE_MS.
 * A dotfile in a lane directory is never read as a contribution (intake lists wolf DIRECTORIES and `*.md`).
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { SWEEP } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";

export const LEASE_FILE = ".sweep-lease";
/** The tick budget: the run budget plus the embed slack tick.ts allows. */
export const TICK_BUDGET_MS = SWEEP.runBudgetMs + SWEEP.embedTimeoutMs * 4;
export const LEASE_STALE_MS = 2 * TICK_BUDGET_MS;
const HEARTBEAT_MS = 30_000;
/** An unparseable lease file is probably being replaced; treat it as held this long after its mtime. */
export const UNREADABLE_GRACE_MS = 10_000;
/** A takeover mutex older than this is cleared whatever its holder pid says (a takeover takes milliseconds). */
export const MUTEX_STALE_MS = 60_000;

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
  /** @internal TEST-ONLY: runs after a lease was judged stale, before the takeover starts (a racing taker). */
  afterJudgedStale?: (dir: string) => void;
}

export const leaseFile = (dir: string) => join(dir, LEASE_FILE);
const mutexFile = (dir: string) => `${leaseFile(dir)}.takeover`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Read = { kind: "none" } | { kind: "unreadable"; mtimeMs: number; raw: string } | { kind: "lease"; lease: Lease; mtimeMs: number; raw: string };

function readRaw(dir: string): Read {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(leaseFile(dir), "utf-8");
    mtimeMs = statSync(leaseFile(dir)).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw e;
  }
  try {
    const lease = JSON.parse(raw) as Lease;
    if ((lease.owner !== "hub" && lease.owner !== "wolf") || !Number.isInteger(lease.pid)) throw new Error("bad lease");
    return { kind: "lease", lease, mtimeMs, raw };
  } catch {
    return { kind: "unreadable", mtimeMs, raw };
  }
}

/** The lease in `dir`, fresh or not (null: none, or unreadable). */
export function readLease(dir: string): { lease: Lease; mtimeMs: number } | null {
  const r = readRaw(dir);
  return r.kind === "lease" ? { lease: r.lease, mtimeMs: r.mtimeMs } : null;
}

type Judged = { state: "none" } | { state: "held"; lease?: Lease; raw: string } | { state: "stale"; raw: string };

function judge(dir: string, opts: LeaseOptions): Judged {
  const r = readRaw(dir);
  if (r.kind === "none") return { state: "none" };
  const now = opts.now?.() ?? Date.now();
  if (r.kind === "unreadable") return now - r.mtimeMs < UNREADABLE_GRACE_MS ? { state: "held", raw: r.raw } : { state: "stale", raw: r.raw };
  if (now - r.mtimeMs >= (opts.staleMs ?? LEASE_STALE_MS)) return { state: "stale", raw: r.raw };
  if (r.lease.host === (opts.host ?? hostname()) && !(opts.pidAlive ?? alive)(r.lease.pid)) return { state: "stale", raw: r.raw };
  return { state: "held", lease: r.lease, raw: r.raw };
}

/** The lease in `dir` when it is fresh (held by a live sweep), else null. An unreadable one counts as held (lease undefined → owner unknown → null here; use acquire to be exact). */
export function freshLease(dir: string, opts: LeaseOptions = {}): Lease | null {
  const j = judge(dir, opts);
  return j.state === "held" ? (j.lease ?? null) : null;
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

/** In-process holds: file -> owner + ref count. */
const held = new Map<string, { owner: LeaseOwner; count: number }>();

function pidOf(raw: string): number | undefined {
  try {
    return (JSON.parse(raw) as { pid?: number }).pid;
  } catch {
    return undefined;
  }
}

/** Publish a complete lease body with linkSync. "ok" | "exists". */
function publish(dir: string, body: string): "ok" | "exists" {
  const file = leaseFile(dir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, file);
    return "ok";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Take over a lease judged stale, under the mutex. True when OUR lease is now in place. */
function takeover(dir: string, judgedRaw: string, body: string, opts: LeaseOptions): boolean {
  opts.afterJudgedStale?.(dir);
  const mf = mutexFile(dir);
  const mine = JSON.stringify({ pid: process.pid, nonce: randomBytes(8).toString("hex") });
  const tmp = `${mf}.${process.pid}.${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, mine);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(tmp, mf);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Another taker holds the mutex. It is cleared when its holder is dead, when it is older than MUTEX_STALE_MS whatever the
      // holder's pid says (a crashed taker whose pid was reused), or when it is unreadable past the grace period; otherwise back off.
      // The compare-then-unlink below is NOT atomic (the mutex could be replaced between the read and the unlink). In that rare race
      // two takers can BOTH win: B can unlink the mutex A has just taken and then A's freshly published lease. That overlap is
      // accepted: it needs a stale mutex plus a second taker racing at the same instant, and there are at most two sweepers (the hub
      // and one wolf-side sweep), so the worst case is those two sweeping the same lane for one tick.
      let seen: string | undefined;
      try {
        seen = readFileSync(mf, "utf-8");
      } catch {
        return false;
      }
      const holder = pidOf(seen);
      const age = Date.now() - (statSync(mf, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if ((holder !== undefined && !(opts.pidAlive ?? alive)(holder)) || age > MUTEX_STALE_MS || (holder === undefined && age > UNREADABLE_GRACE_MS)) {
        try {
          if (readFileSync(mf, "utf-8") === seen) unlinkSync(mf);
        } catch (er) {
          if ((er as NodeJS.ErrnoException).code !== "ENOENT") throw er;
        }
      }
      return false; // the caller treats it as "held"; the next tick re-judges
    }
    try {
      // Re-judge UNDER the mutex (age and pid liveness, not just the bytes): a heartbeat or a new lease that landed between the
      // first judgment and the mutex makes it held, and it is not ours to remove.
      const again = judge(dir, opts);
      if (again.state === "none") return publish(dir, body) === "ok";
      if (again.state === "held" || again.raw !== judgedRaw) return false;
      try {
        unlinkSync(leaseFile(dir));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      return publish(dir, body) === "ok";
    } finally {
      try {
        if (readFileSync(mf, "utf-8") === mine) unlinkSync(mf);
      } catch {
        /* gone */
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

function dropIfMine(dir: string, owner: LeaseOwner): void {
  const got = readLease(dir);
  if (got && got.lease.pid === process.pid && got.lease.owner === owner) {
    try {
      unlinkSync(leaseFile(dir));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

/** Take the lease in every dir. Null (and nothing held) when a fresh lease of another owner, or another live process, holds one. */
export function acquireLease(dirs: string[], owner: LeaseOwner, opts: LeaseOptions = {}): LeaseHandle | null {
  const host = opts.host ?? hostname();
  const body = JSON.stringify({ owner, pid: process.pid, host, at: new Date().toISOString() } satisfies Lease);
  const taken: string[] = []; // dirs whose ref count we raised
  const undo = () => {
    for (const d of taken.splice(0)) unref(d, owner);
  };
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    const file = leaseFile(dir);
    let here = held.get(file);
    if (here) {
      // Only while the file is still ours: a lease removed or replaced behind our back is not shared.
      const cur = readLease(dir);
      if (!cur || cur.lease.pid !== process.pid || cur.lease.owner !== here.owner) {
        held.delete(file);
        here = undefined;
      }
    }
    if (here) {
      if (here.owner !== owner) {
        undo();
        return null;
      }
      here.count++;
      taken.push(dir);
      continue;
    }
    let got = false;
    for (let attempt = 0; attempt < 3 && !got; attempt++) {
      if (publish(dir, body) === "ok") {
        got = true;
        break;
      }
      const j = judge(dir, opts);
      if (j.state === "none") continue; // vanished: retry the publish
      if (j.state === "held") break;
      if (takeover(dir, j.raw, body, opts)) got = true;
      else break;
    }
    if (!got) {
      undo();
      return null;
    }
    held.set(file, { owner, count: 1 });
    taken.push(dir);
  }
  const beat = setInterval(() => {
    const t = new Date();
    for (const d of taken) {
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
      undo();
    },
  };
}

function unref(dir: string, owner: LeaseOwner): void {
  const file = leaseFile(dir);
  const here = held.get(file);
  if (!here) return;
  if (--here.count > 0) return;
  held.delete(file);
  dropIfMine(dir, owner);
}

/** The lane dirs a wolf-side sweep of these roots shares with the hub curator. */
export function wolfLeaseDirs(roots: KbRoots): string[] {
  return [join(roots.opsRoot, "inbox"), join(roots.opsRoot, "contributions")];
}
