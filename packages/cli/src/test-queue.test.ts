import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatWait, openQueue } from "./test-queue.js";

let dir: string;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "test-queue-"));
  clock = 1_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = async (ms: number) => {
  clock += ms;
};
const open = (slots: number, identity?: { pid: number; start?: string }) => openQueue({ dir, slots, now: () => clock, sleep, ...(identity ? { identity } : {}) });
const run = (wolf: string) => ({ wolf, cwd: `/w/${wolf}`, args: ["related", `${wolf}.ts`] });

describe("test queue", () => {
  it("admits in arrival order, at most `slots` at a time", async () => {
    const q = open(2);
    const a = await q.enqueue(run("a"));
    const b = await q.enqueue(run("b"));
    const c = await q.enqueue(run("c"));
    expect(await q.waitTurn(a, { timeoutMs: 1000 })).toEqual({ admitted: true });
    expect(await q.waitTurn(b, { timeoutMs: 1000 })).toEqual({ admitted: true });
    const blocked = await q.waitTurn(c, { timeoutMs: 1000 });
    expect(blocked.admitted).toBe(false);
    const c2 = await q.enqueue(run("c"));
    await q.release(a);
    expect(await q.waitTurn(c2, { timeoutMs: 1000 })).toEqual({ admitted: true });
    expect(q.snapshot().map((e) => e.wolf)).toEqual(["b", "c"]);
  });

  it("a waiting ticket does not jump the line while an earlier one still waits", async () => {
    const q = open(1);
    const a = await q.enqueue(run("a"));
    const b = await q.enqueue(run("b"));
    const c = await q.enqueue(run("c"));
    await q.waitTurn(a, { timeoutMs: 1000 });
    await q.release(a);
    // c asks first but b is ahead of it
    const rc = await q.waitTurn(c, { timeoutMs: 500 });
    expect(rc.admitted).toBe(false);
    expect(await q.waitTurn(b, { timeoutMs: 500 })).toEqual({ admitted: true });
  });

  it("sweeps the ticket of a process that is gone", async () => {
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const gonePid = Number(dead.stdout);
    const ghost = open(1, { pid: gonePid, start: "x" });
    const g = await ghost.enqueue(run("ghost"));
    await ghost.waitTurn(g, { timeoutMs: 1000 }).catch(() => undefined);
    const q = open(1);
    const mine = await q.enqueue(run("me"));
    expect(await q.waitTurn(mine, { timeoutMs: 1000 })).toEqual({ admitted: true });
    expect(q.snapshot().map((e) => e.wolf)).toEqual(["me"]);
  });

  it("treats a live pid with a different start time as dead (pid reuse)", async () => {
    const reused = open(1, { pid: process.pid, start: "Thu Jan  1 00:00:00 1970" });
    const old = await reused.enqueue(run("old"));
    await reused.waitTurn(old, { timeoutMs: 1000 });
    const q = open(1);
    const mine = await q.enqueue(run("me"));
    expect(await q.waitTurn(mine, { timeoutMs: 1000 })).toEqual({ admitted: true });
    expect(q.snapshot().map((e) => e.wolf)).toEqual(["me"]);
  });

  it("on timeout removes its own ticket and reports who holds the slots", async () => {
    const q = open(1);
    const a = await q.enqueue(run("a"));
    await q.waitTurn(a, { timeoutMs: 1000 });
    const b = await q.enqueue(run("b"));
    const r = await q.waitTurn(b, { timeoutMs: 5_000 });
    expect(r.admitted).toBe(false);
    if (r.admitted) throw new Error("unreachable");
    expect(r.holders.map((h) => h.wolf)).toEqual(["a"]);
    expect(q.snapshot().map((e) => e.wolf)).toEqual(["a"]);
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("describes the place in line and the run that is going", async () => {
    const q = open(1);
    const a = await q.enqueue({ wolf: "1uk4", cwd: "/w/x", args: ["related", "a.ts"] });
    await q.waitTurn(a, { timeoutMs: 1000 });
    clock += 192_000;
    const b = await q.enqueue(run("b"));
    const c = await q.enqueue(run("c"));
    expect(c.seq).toBeGreaterThan(b.seq);
    expect(formatWait(q.status(c), clock)).toBe(
      "Waiting for a test slot: 2nd in line (1 ahead of you). Running now: 1uk4 in /w/x: wolfpack test related a.ts (3m12s).",
    );
  });
});

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("test queue under contention", () => {
  it("never looks up process start times while holding the lock", async () => {
    const inLock: number[] = [];
    let probed = 0;
    const probe = (pid: number) => {
      probed++;
      if (existsSync(join(dir, ".lock"))) inLock.push(pid);
      return "S";
    };
    const q = openQueue({ dir, slots: 1, now: () => clock, sleep, probe, identity: { pid: process.pid, start: "S" } });
    const a = await q.enqueue(run("a"));
    const b = await q.enqueue(run("b"));
    await q.waitTurn(a, { timeoutMs: 1000 });
    await q.waitTurn(b, { timeoutMs: 50 });
    expect(probed).toBeGreaterThan(0);
    expect(inLock).toEqual([]);
  });

  it("a busy lock makes a waiter retry, not throw", async () => {
    const q = openQueue({ dir, slots: 1, lockWaitMs: 30, pollMs: 20, sleep: realSleep });
    const t = await q.enqueue(run("a"));
    mkdirSync(join(dir, ".lock"));
    writeFileSync(join(dir, ".lock", "owner"), "someone-else");
    // busy for longer than the default lock wait (2 s): only a retrying waiter survives
    setTimeout(() => rmSync(join(dir, ".lock"), { recursive: true, force: true }), 2600);
    expect(await q.waitTurn(t, { timeoutMs: 10_000 })).toEqual({ admitted: true });
  });

  it("enqueue gives up with a clear message when the lock stays busy", async () => {
    const q = openQueue({ dir, slots: 1, lockWaitMs: 10, sleep });
    mkdirSync(join(dir, ".lock"));
    writeFileSync(join(dir, ".lock", "owner"), "someone-else");
    await expect(q.enqueue(run("a"))).rejects.toThrow(/lock is busy/);
  });

  it("two real processes racing get distinct seqs and are admitted in order", async () => {
    const script = join(dir, "..", `queue-child-${process.pid}.mjs`);
    const mod = fileURLToPath(new URL("./test-queue.ts", import.meta.url));
    writeFileSync(
      script,
      `import { openQueue } from ${JSON.stringify(mod)};
const q = openQueue({ dir: process.argv[2], slots: 1, pollMs: 20 });
const seqs = [];
for (let i = 0; i < 8; i++) { const t = await q.enqueue({ wolf: process.argv[3], cwd: "/", args: [] }); seqs.push(t.seq); await q.release(t); }
const t = await q.enqueue({ wolf: process.argv[3], cwd: "/", args: [] });
console.log(JSON.stringify({ seqs, last: t.seq }));
const r = await q.waitTurn(t, { timeoutMs: 20000 });
console.log("admitted " + r.admitted);
process.stdin.once("data", async () => { await q.release(t); process.exit(0); });
`,
    );
    const child = (wolf: string) => {
      const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, dir, wolf], { stdio: ["pipe", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      return { p, out: () => out };
    };
    // a holder fills the single slot so both children must wait, then both race
    const holder = openQueue({ dir, slots: 1 });
    const h = await holder.enqueue(run("holder"));
    await holder.waitTurn(h, { timeoutMs: 1000 });
    const a = child("a");
    const b = child("b");
    for (let i = 0; i < 400 && !(a.out().includes("last") && b.out().includes("last")); i++) await realSleep(25);
    const ra = JSON.parse(a.out().split("\n")[0]!);
    const rb = JSON.parse(b.out().split("\n")[0]!);
    const all = [...ra.seqs, ra.last, ...rb.seqs, rb.last];
    expect(ra.last).not.toBe(rb.last);
    // each child's 8 throw-away tickets and its real one: no seq is ever handed out twice while its ticket exists
    expect(new Set([ra.last, rb.last, h.seq]).size).toBe(3);
    expect(all.every((n: number) => n > h.seq)).toBe(true);
    const first = ra.last < rb.last ? a : b;
    const second = first === a ? b : a;
    await holder.release(h);
    for (let i = 0; i < 200 && !first.out().includes("admitted true"); i++) await realSleep(25);
    expect(first.out()).toContain("admitted true");
    expect(second.out()).not.toContain("admitted");
    first.p.stdin.write("go\n");
    for (let i = 0; i < 200 && !second.out().includes("admitted true"); i++) await realSleep(25);
    expect(second.out()).toContain("admitted true");
    second.p.stdin.write("go\n");
    rmSync(script, { force: true });
  }, 30_000);
});

describe("test queue orphans", () => {
  it("the sweep kills the vitest group a crashed runner left behind and frees its ticket", async () => {
    const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    // the "vitest": its own process group that outlives its runner
    const orphan = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    orphan.unref();
    const runner = openQueue({ dir, slots: 1, identity: { pid: dead, start: "x" } });
    const t = await runner.enqueue(run("crashed"));
    await runner.setChild(t, { pgid: orphan.pid! });
    const q = openQueue({ dir, slots: 1, pollMs: 20, sleep: realSleep });
    const mine = await q.enqueue(run("me"));
    expect(await q.waitTurn(mine, { timeoutMs: 10_000 })).toEqual({ admitted: true });
    expect(() => process.kill(-orphan.pid!, 0)).toThrow();
    expect(q.snapshot().map((e) => e.wolf)).toEqual(["me"]);
  }, 20_000);

  // A "vitest" stand-in: its own process group that outlives its runner. `term` = ignores SIGTERM.
  const groups: number[] = [];
  afterEach(() => groups.splice(0).forEach((g) => { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }));
  const orphanGroup = (term = false) => {
    const c = spawn(process.execPath, ["-e", `${term ? "process.on('SIGTERM',()=>{});" : ""}setInterval(()=>{},1000)`], { detached: true, stdio: "ignore" });
    c.unref();
    groups.push(c.pid!);
    return c.pid!;
  };
  const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
  const alive = (g: number) => { try { process.kill(-g, 0); return true; } catch { return false; } };

  it("never kills a live group whose recorded start differs from its leader's (pid reuse)", async () => {
    const g = orphanGroup();
    const runner = openQueue({ dir, slots: 1, identity: { pid: deadPid(), start: "x" } });
    const t = await runner.enqueue(run("crashed"));
    await runner.setChild(t, { pgid: g, start: "recorded-long-ago" });
    const q = openQueue({ dir, slots: 1, probe: () => "a different process now" });
    q.snapshot();
    q.snapshot();
    expect(alive(g)).toBe(true);
    expect(q.snapshot()).toEqual([]); // the ticket is stale, the stranger is left alone
  });

  it("does not kill when ps fails, and tries again on the next poll", async () => {
    const g = orphanGroup();
    const runner = openQueue({ dir, slots: 1, identity: { pid: deadPid(), start: "x" } });
    const t = await runner.enqueue(run("crashed"));
    await runner.setChild(t, { pgid: g, start: "S" });
    let psWorks = false;
    const q = openQueue({ dir, slots: 1, probe: (pid) => (pid === g && psWorks ? "S" : undefined) });
    expect(q.snapshot().map((e) => e.wolf)).toEqual(["crashed"]); // still holds its slot
    expect(alive(g)).toBe(true);
    psWorks = true;
    q.snapshot();
    await realSleep(300);
    expect(alive(g)).toBe(false);
  });

  it("never kills a group whose start time was not recorded", async () => {
    const g = orphanGroup();
    const runner = openQueue({ dir, slots: 1, identity: { pid: deadPid(), start: "x" }, probe: () => undefined });
    const t = await runner.enqueue(run("crashed"));
    await runner.setChild(t, { pgid: g }); // ps failed when recording
    const q = openQueue({ dir, slots: 1, probe: () => "S" });
    q.snapshot();
    await realSleep(200);
    expect(alive(g)).toBe(true);
    expect(q.snapshot()).toEqual([]);
  });

  it("times the SIGKILL grace (10 s) from a timestamp in the ticket, not from the next poll", async () => {
    const g = orphanGroup(true);
    const runner = openQueue({ dir, slots: 1, identity: { pid: deadPid(), start: "x" }, probe: () => "S" });
    const t = await runner.enqueue(run("crashed"));
    await runner.setChild(t, { pgid: g });
    // a fresh queue handle at every step: nothing is remembered in memory
    const at = (ms: number) => openQueue({ dir, slots: 1, now: () => 5_000_000 + ms, probe: () => "S" });
    at(0).snapshot(); // SIGTERM, which the stub ignores
    await realSleep(150);
    expect(alive(g)).toBe(true);
    at(5_000).snapshot();
    await realSleep(150);
    expect(alive(g)).toBe(true); // 5 s in: still inside the grace
    at(10_000).snapshot(); // grace over: SIGKILL
    await realSleep(300);
    expect(alive(g)).toBe(false);
    expect(at(10_100).snapshot()).toEqual([]);
  }, 20_000);
});

describe("test queue bookkeeping", () => {
  it("warns once when it cannot record the vitest process because the lock stays busy", async () => {
    const warnings: string[] = [];
    const q = openQueue({ dir, slots: 1, lockWaitMs: 10, sleep, warn: (l) => warnings.push(l), identity: { pid: process.pid, start: "S" }, probe: () => "S" });
    const t = await q.enqueue(run("a"));
    mkdirSync(join(dir, ".lock"));
    writeFileSync(join(dir, ".lock", "owner"), "someone-else");
    await q.setChild(t, { pgid: process.pid });
    expect(warnings).toEqual(["test queue: could not record the vitest process; if this run crashes, its vitest may keep running"]);
  });

  it("sweeps leftover temp files older than a minute and leaves fresh ones", async () => {
    const q = open(1);
    const old = join(dir, ".00000009.json.123.tmp");
    const fresh = join(dir, ".00000010.json.123.tmp");
    writeFileSync(old, "{");
    writeFileSync(fresh, "{");
    const t = new Date(Date.now() - 120_000);
    utimesSync(old, t, t);
    q.snapshot();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("test queue release", () => {
  it("a released ticket is not recreated by a setChild that was mid-flight (the runner pid stays alive)", async () => {
    let releasing: Promise<void> | undefined;
    // ps takes a while in real life: the release lands while setChild is working out the start time
    const q: ReturnType<typeof openQueue> = openQueue({ dir, slots: 1, sleep: realSleep, identity: { pid: process.pid, start: "S" }, probe: () => { releasing = q.release(ticket); return "S"; } });
    const ticket = await q.enqueue(run("a"));
    await q.setChild(ticket, { pgid: process.pid });
    await releasing;
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  it("a waiter whose ticket is released stops with a cancellation and never writes it back", async () => {
    const q = open(1);
    const a = await q.enqueue(run("a"));
    await q.waitTurn(a, { timeoutMs: 1000 });
    const b = await q.enqueue(run("b"));
    const waiting = openQueue({ dir, slots: 1, pollMs: 20, sleep: realSleep }).waitTurn(b, { timeoutMs: 10_000 });
    const w = waiting.catch((e) => e);
    await realSleep(60);
    await openQueue({ dir, slots: 1 }).release(b);
    await q.release(a);
    expect(await w).toMatchObject({ message: expect.stringMatching(/cancelled|removed/) });
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual([]);
  });
});
