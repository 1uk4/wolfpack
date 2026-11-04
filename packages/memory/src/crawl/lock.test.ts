import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, bootsDiffer, lockHeld, releaseLock, type LockEnv } from "./lock.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "crawl-lock-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const env = (o: Partial<LockEnv> = {}): LockEnv => ({ pid: 1, host: "h", boot: "b", isAlive: () => true, now: () => Date.now(), ...o });

describe("file locks", () => {
  it("publishes atomically (full body, no tmp leftovers) and a second acquire is refused", () => {
    const f = join(tmp(), "x.lock");
    const a = acquireLock(f, 60_000, env());
    expect(a).toBeTruthy();
    expect(JSON.parse(readFileSync(f, "utf-8"))).toMatchObject({ pid: 1, host: "h", boot: "b", token: a!.token });
    expect(acquireLock(f, 60_000, env({ pid: 2 }))).toBeUndefined();
  });

  it("a half-written / unreadable lock is NOT removed while fresh; once its mtime is old it is taken over", () => {
    const f = join(tmp(), "x.lock");
    writeFileSync(f, '{"pid": 12');
    expect(acquireLock(f, 60_000, env())).toBeUndefined();
    expect(existsSync(f)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(f, old, old);
    expect(acquireLock(f, 60_000, env())).toBeTruthy();
  });

  it("two processes racing a stale-lock takeover: only one wins", () => {
    const f = join(tmp(), "x.lock");
    writeFileSync(f, JSON.stringify({ pid: 99, host: "h", boot: "b", at: Date.now(), token: "dead" }));
    let b: ReturnType<typeof acquireLock>;
    const dead = (p: number) => p !== 99;
    // A judged the lock stale; before it takes over, B runs the whole takeover and wins.
    const a = acquireLock(f, 60_000, env({ pid: 1, isAlive: dead, afterJudge: () => { b = acquireLock(f, 60_000, env({ pid: 2, isAlive: dead })); } }));
    expect(b!).toBeTruthy();
    expect(a).toBeUndefined();
    expect(JSON.parse(readFileSync(f, "utf-8")).token).toBe(b!.token);
  });

  it("unlock after a takeover does not delete the new owner's lock", () => {
    const f = join(tmp(), "x.lock");
    let t = 1000;
    const a = acquireLock(f, 10, env({ pid: 1, now: () => t }))!;
    t += 100; // A's lock is now too old
    const b = acquireLock(f, 10, env({ pid: 2, now: () => t }))!;
    expect(b).toBeTruthy();
    releaseLock(a);
    expect(existsSync(f)).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf-8")).token).toBe(b.token);
    releaseLock(b);
    expect(existsSync(f)).toBe(false);
  });

  it("another host: a fresh lock is held (the pid cannot be checked), an old one is stale; same host + dead pid is stale at once", () => {
    const d = tmp();
    mkdirSync(d, { recursive: true });
    const f = join(d, "x.lock");
    const body = (o: object) => JSON.stringify({ pid: 5, host: "other", boot: "zz", at: Date.now(), token: "t", ...o });
    writeFileSync(f, body({}));
    expect(lockHeld(f, 60_000, env({ isAlive: () => false }))).toBe(true);
    writeFileSync(f, body({ at: Date.now() - 120_000 }));
    expect(lockHeld(f, 60_000, env())).toBe(false);
    writeFileSync(f, body({ host: "h", boot: "b" }));
    expect(lockHeld(f, 60_000, env({ isAlive: () => false }))).toBe(false);
    writeFileSync(f, body({ host: "h", boot: "old" })); // same host, other boot id: stale at once
    expect(lockHeld(f, 60_000, env())).toBe(false);
  });

  it("an unknown boot id never proves a difference", () => {
    expect(bootsDiffer("unknown", "b")).toBe(false);
    expect(bootsDiffer("a", "b")).toBe(true);
    expect(bootsDiffer("a", "a")).toBe(false);
  });
});
