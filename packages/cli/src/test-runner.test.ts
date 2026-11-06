import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openQueue } from "./test-queue.js";
import { isAgentRun, parseTestArgs, runTests, testSettings } from "./test-runner.js";

let tmp: string;
let repo: string;
let logs: string[];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "test-runner-"));
  repo = join(tmp, "repo");
  execFileSync("mkdir", [repo]);
  for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) execFileSync("git", a, { cwd: repo });
  writeFileSync(join(repo, "a.ts"), "export {};\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: repo });
  logs = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// A stand-in for vitest's bin: records each call, writes the json report when asked, and behaves as the env says.
const stub = join(tmpdir(), `stub-vitest-${process.pid}.mjs`);
writeFileSync(
  stub,
  `import fs from "node:fs"; import os from "node:os";
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: a, nice: os.getPriority() }) + "\\n");
const o = a.find((x) => x.startsWith("--outputFile.json="));
if (o) fs.writeFileSync(o.slice(18), JSON.stringify({ testResults: [{ name: process.env.STUB_FILE ?? "/r/packages/cli/src/x.test.ts" }] }));
console.log("stub says hi");
if (process.env.STUB_EDIT) fs.appendFileSync(process.env.STUB_EDIT, "// edited during the run\\n");
if (process.env.STUB_IGNORE_TERM) process.on("SIGTERM", () => {});
if (process.env.STUB_HANG) { fs.writeFileSync(process.env.STUB_HANG, String(process.pid)); setInterval(() => {}, 1000); }
else process.exit(Number(process.env.STUB_EXIT ?? 0));
`,
);

const base = () => ({
  root: repo,
  vitestBin: stub,
  vitestVersion: "3.0.0",
  queueDir: join(tmp, "queue"),
  cacheDir: join(tmp, "cache"),
  settings: { slots: 1, workersPerRun: 2 },
  log: (l: string) => logs.push(l),
  sleep: async () => {},
});
const calls = () => (existsSync(join(tmp, "calls.log")) ? readFileSync(join(tmp, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; nice: number }) : []);
const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", STUB_LOG: join(tmp, "calls.log"), ...extra });

describe("wolfpack test runner", () => {
  it("passes the vitest exit code through and caps workers from the config", async () => {
    const code = await runTests({ ...base(), args: ["run", "a.test.ts"], env: env({ STUB_EXIT: "3" }), settings: { slots: 1, workersPerRun: 3 }, stdio: "ignore" });
    expect(code).toBe(3);
    expect(calls()[0]!.args).toContain("--maxWorkers=3");
    expect(calls()[0]!.args.slice(0, 2)).toEqual(["run", "a.test.ts"]);
  });

  it("reruns a failure, and a pass is served from the cache without starting vitest", async () => {
    const o = { ...base(), args: ["run", "a.test.ts"], stdio: "ignore" as const };
    expect(await runTests({ ...o, env: env({ STUB_EXIT: "1" }) })).toBe(1);
    expect(await runTests({ ...o, env: env({ STUB_EXIT: "1" }) })).toBe(1);
    expect(calls()).toHaveLength(2);
    expect(await runTests({ ...o, env: env() })).toBe(0);
    expect(calls()).toHaveLength(3);
    logs.length = 0;
    expect(await runTests({ ...o, env: env() })).toBe(0);
    expect(calls()).toHaveLength(3);
    expect(logs.join("\n")).toMatch(/^PASS \(cached: same files, command and environment passed on this host at .+\)$/m);
    // --no-cache runs it again
    expect(await runTests({ ...o, noCache: true, env: env() })).toBe(0);
    expect(calls()).toHaveLength(4);
  });

  it("never caches a pass whose run included a test that reads the home config", async () => {
    const o = { ...base(), args: ["run", "a.test.ts"], stdio: "ignore" as const, env: env({ STUB_FILE: "/r/packages/cli/src/sandbox-cmd.test.ts" }) };
    await runTests(o);
    await runTests(o);
    expect(calls()).toHaveLength(2);
  });

  it("runs vitest at a lower priority", async () => {
    await runTests({ ...base(), args: ["run"], env: env(), stdio: "ignore", noCache: true });
    expect(calls()[0]!.nice).toBeGreaterThanOrEqual(10);
  });

  it("agents wait for a slot and give up with 75; the owner skips the queue", async () => {
    const holder = openQueue({ dir: join(tmp, "queue"), slots: 1 });
    const t = await holder.enqueue({ wolf: "other", cwd: "/w/o", args: ["run"] });
    await holder.waitTurn(t, { timeoutMs: 10 });
    let clock = 0;
    const waiting = { ...base(), args: ["run", "a.test.ts"], stdio: "ignore" as const, queueTimeoutMs: 20 * 60_000, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
    expect(await runTests({ ...waiting, env: env({ WOLFPACK_AGENT_RUN: "1", WOLF_NAME: "me" }) })).toBe(75);
    expect(calls()).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/Waiting for a test slot: 1st in line.*other in \/w\/o/);
    expect(logs.join("\n")).toMatch(/gave up after 20 minutes/);
    expect(holder.snapshot().map((e) => e.wolf)).toEqual(["other"]);
    expect(await runTests({ ...waiting, env: env() })).toBe(0);
    expect(calls()).toHaveLength(1);
  });

  it("an agent run takes a slot, then frees it", async () => {
    const q = openQueue({ dir: join(tmp, "queue"), slots: 1 });
    expect(await runTests({ ...base(), args: ["run"], env: env({ WOLFPACK_AGENT_RUN: "1" }), stdio: "ignore" })).toBe(0);
    expect(q.snapshot()).toEqual([]);
  });

  it("on SIGTERM kills the child, frees the ticket and exits 143", async () => {
    const sig = new EventEmitter();
    const pidFile = join(tmp, "child.pid");
    const q = openQueue({ dir: join(tmp, "queue"), slots: 1 });
    const p = runTests({ ...base(), args: ["run"], env: env({ WOLFPACK_AGENT_RUN: "1", STUB_HANG: pidFile }), stdio: "ignore", signals: sig });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 25));
    expect(q.snapshot()).toHaveLength(1);
    sig.emit("SIGTERM");
    expect(await p).toBe(143);
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(() => process.kill(pid, 0)).toThrow();
    expect(q.snapshot()).toEqual([]);
  });
});

describe("wolfpack test runner: interruption, timeouts, drift", () => {
  it("does not remember a pass when the tree changed during the run", async () => {
    const o = { ...base(), args: ["run", "a.test.ts"], stdio: "ignore" as const };
    expect(await runTests({ ...o, env: env({ STUB_EDIT: join(repo, "a.ts") }) })).toBe(0);
    // the edit is undone: the tree is exactly as it was when the run began. A pass filed under that state would be wrong.
    writeFileSync(join(repo, "a.ts"), "export {};\n");
    expect(await runTests({ ...o, env: env() })).toBe(0);
    expect(calls()).toHaveLength(2);
  });

  it("a signal while still joining the queue exits promptly and leaves no ticket", async () => {
    const dir = join(tmp, "queue");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, ".lock"));
    writeFileSync(join(dir, ".lock", "owner"), "someone-else");
    const sig = new EventEmitter();
    const t0 = Date.now();
    const p = runTests({ ...base(), args: ["run"], env: env({ WOLFPACK_AGENT_RUN: "1" }), stdio: "ignore", signals: sig, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    setTimeout(() => sig.emit("SIGINT"), 100);
    expect(await p).toBe(130);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(openQueue({ dir, slots: 1 }).snapshot()).toEqual([]);
    expect(calls()).toHaveLength(0);
  });

  it("after the run timeout sends SIGTERM and then SIGKILL to a vitest that ignores it", async () => {
    const pidFile = join(tmp, "child.pid");
    const code = await runTests({ ...base(), args: ["run"], env: env({ STUB_HANG: pidFile, STUB_IGNORE_TERM: "1" }), stdio: "ignore", noCache: true, runTimeoutMs: 400, killGraceMs: 300 });
    expect(code).toBe(124);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("records the vitest process group in the ticket while it runs", async () => {
    const pidFile = join(tmp, "child.pid");
    const sig = new EventEmitter();
    const q = openQueue({ dir: join(tmp, "queue"), slots: 1 });
    const p = runTests({ ...base(), args: ["run"], env: env({ WOLFPACK_AGENT_RUN: "1", STUB_HANG: pidFile }), stdio: "ignore", signals: sig });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 25));
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 40 && !q.snapshot()[0]?.child; i++) await new Promise((r) => setTimeout(r, 25));
    expect(q.snapshot()[0]?.child?.pgid).toBe(pid);
    sig.emit("SIGTERM");
    await p;
  });
});

describe("wolfpack test settings and arguments", () => {
  it("defaults to 2 slots and 2 workers; the config and then the env override; bad values are refused", () => {
    expect(testSettings({}, {})).toEqual({ slots: 2, workersPerRun: 2 });
    expect(testSettings({ tests: { slots: 3, workersPerRun: 4 } }, {})).toEqual({ slots: 3, workersPerRun: 4 });
    expect(testSettings({ tests: { slots: 3 } }, { WOLFPACK_TEST_SLOTS: "1", WOLFPACK_TEST_WORKERS: "5" })).toEqual({ slots: 1, workersPerRun: 5 });
    expect(() => testSettings({ tests: { slots: 0 } }, {})).toThrow(/tests\.slots/);
    expect(() => testSettings({}, { WOLFPACK_TEST_WORKERS: "1.5" })).toThrow(/tests\.workersPerRun/);
  });

  it("knows an agent run, and the bypass", () => {
    expect(isAgentRun({})).toBe(false);
    expect(isAgentRun({ WOLFPACK_AGENT_RUN: "1" })).toBe(true);
    expect(isAgentRun({ PI_SUBAGENT_AGENT: "worker" })).toBe(true);
    expect(isAgentRun({ PI_SUBAGENT_AGENT: "" })).toBe(false);
    expect(isAgentRun({ WOLFPACK_AGENT_RUN: "1", WOLFPACK_TEST_BYPASS: "1" })).toBe(false);
  });

  it("resolves path arguments against the caller's directory, relative to the repo root", () => {
    const sub = join(repo, "packages", "x");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "a.test.ts"), "");
    const ctx = { cwd: sub, root: repo };
    expect(parseTestArgs(["test", "related", "a.ts", "../y.ts"], ctx).args).toEqual(["related", "packages/x/a.ts", "packages/y.ts", "--run"]);
    // an existing path is resolved; a word that is no path stays a vitest filter; -t takes a name, not a path
    expect(parseTestArgs(["test", "run", "a.test.ts", "queue", "-t", "a.ts"], ctx).args).toEqual(["run", "packages/x/a.test.ts", "queue", "-t", "a.ts"]);
    expect(parseTestArgs(["test", "run", "a.test.ts"], { cwd: repo, root: repo }).args).toEqual(["run", "a.test.ts"]);
    // a bare word that names an existing path at the caller's cwd is that path; one with no such path is a filter
    mkdirSync(join(sub, "src"), { recursive: true });
    expect(parseTestArgs(["test", "run", "src", "queue", "sub/dir", "x.test.ts"], ctx).args).toEqual(["run", "packages/x/src", "queue", "packages/x/sub/dir", "packages/x/x.test.ts"]);
    expect(() => parseTestArgs(["test", "related", "../../../outside.ts"], ctx)).toThrow(/outside the repo/);
  });

  it("accepts run and related with paths, and refuses anything else", () => {
    expect(parseTestArgs(["test", "related", "b.ts", "a.ts", "--no-cache"])).toEqual({ args: ["related", "b.ts", "a.ts", "--run"], noCache: true });
    expect(parseTestArgs(["test"])).toEqual({ args: ["run"], noCache: false });
    expect(parseTestArgs(["test", "run", "packages/cli", "-t", "queue"])).toEqual({ args: ["run", "packages/cli", "-t", "queue"], noCache: false });
    expect(() => parseTestArgs(["test", "--watch"])).toThrow(/unknown argument/);
    expect(() => parseTestArgs(["test", "run", "--config=/x.ts"])).toThrow(/unknown argument/);
  });
});
