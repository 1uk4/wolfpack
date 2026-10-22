import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireKbLock, withKbLock, kbLockFile, KbLockBusy, LOCK_HEARTBEAT_MS, LOCK_STALE_MS } from "./lock.js";
import type { KbRoots } from "../shared/index.js";

describe("kb lock", () => {
  let base: string;
  let roots: KbRoots;
  let file: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-lock-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    file = kbLockFile(roots);
    mkdirSync(roots.denLocal, { recursive: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  const writeLock = (pid: number, ageMs = 0) => {
    writeFileSync(file, JSON.stringify({ pid, at: Date.now() - ageMs }));
    const t = new Date(Date.now() - ageMs);
    utimesSync(file, t, t);
  };
  /** A live pid that is not ours: our parent (the test runner's launcher). */
  const otherLivePid = process.ppid;
  /** A pid that is certainly dead: a reaped child. */
  const deadPid = () =>
    new Promise<number>((res) => {
      const c = spawn(process.execPath, ["-e", "0"]);
      c.on("exit", () => res(c.pid!));
    });

  it("exactly one of several concurrent processes wins", async () => {
    const script = join(base, "acquire.ts");
    const lockSrc = resolve(fileURLToPath(new URL(".", import.meta.url)), "lock.ts");
    writeFileSync(
      script,
      `import { acquireKbLock } from ${JSON.stringify(lockSrc)};
const roots = JSON.parse(process.argv[2]);
const startAt = Number(process.argv[3]);
while (Date.now() < startAt) {}
const release = acquireKbLock(roots);
console.log(release ? "won" : "busy");
if (release) setTimeout(release, 3000); else process.exit(0);
`
    );
    const bin = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../node_modules/.bin/vite-node");
    const startAt = Date.now() + 6000;
    const run = () =>
      new Promise<string>((res, rej) => {
        let out = "";
        const c = spawn(bin, [script, JSON.stringify(roots), String(startAt)], { cwd: base });
        c.stdout.on("data", (d) => (out += d));
        c.on("error", rej);
        c.on("exit", () => res(out.trim()));
      });
    const results = await Promise.all([run(), run(), run(), run()]);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "busy")).toHaveLength(3);
  }, 60_000);

  it("writes our pid and removes the file on release", () => {
    const release = acquireKbLock(roots)!;
    expect(release).toBeTypeOf("function");
    expect(JSON.parse(readFileSync(file, "utf-8")).pid).toBe(process.pid);
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a live holder with a fresh heartbeat", () => {
    writeLock(otherLivePid);
    expect(acquireKbLock(roots)).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf-8")).pid).toBe(otherLivePid);
  });

  it("keeps a live holder whose acquisition is old but whose heartbeat is fresh", () => {
    writeFileSync(file, JSON.stringify({ pid: otherLivePid, at: Date.now() - 3 * LOCK_STALE_MS }));
    expect(acquireKbLock(roots)).toBeNull();
  });

  it("reclaims a lock whose pid is dead", async () => {
    writeLock(await deadPid());
    const release = acquireKbLock(roots);
    expect(release).not.toBeNull();
    expect(JSON.parse(readFileSync(file, "utf-8")).pid).toBe(process.pid);
    release!();
  });

  it("reclaims a live pid whose heartbeat is older than the stale window", () => {
    writeLock(otherLivePid, LOCK_STALE_MS + 60_000);
    const release = acquireKbLock(roots);
    expect(release).not.toBeNull();
    release!();
  });

  it("reclaims a garbage lock once it is past the grace period, not before", () => {
    writeFileSync(file, "{not json");
    expect(acquireKbLock(roots)).toBeNull();
    const t = new Date(Date.now() - 60_000);
    utimesSync(file, t, t);
    const release = acquireKbLock(roots);
    expect(release).not.toBeNull();
    release!();
  });

  it("heartbeat refreshes the mtime while held", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const release = acquireKbLock(roots)!;
    const t = new Date(Date.now() - 10 * 60_000);
    utimesSync(file, t, t);
    const before = statSync(file).mtimeMs;
    vi.advanceTimersByTime(LOCK_HEARTBEAT_MS + 1);
    expect(statSync(file).mtimeMs).toBeGreaterThan(before);
    release();
  });

  it("nested withKbLock proceeds when this pid already holds the lock, and leaves it for the outer owner", async () => {
    const release = acquireKbLock(roots)!;
    await withKbLock(roots, async () => {});
    expect(existsSync(file)).toBe(true);
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("withKbLock throws KbLockBusy when another process holds it", async () => {
    writeLock(otherLivePid);
    await expect(withKbLock(roots, async () => {})).rejects.toBeInstanceOf(KbLockBusy);
  });

  it("withKbLock serialises in-process callers and removes the lock afterwards", async () => {
    const order: string[] = [];
    const a = withKbLock(roots, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a-end");
    });
    const b = withKbLock(roots, async () => void order.push("b"), { waitMs: 5000 });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    expect(existsSync(file)).toBe(false);
  });
});
