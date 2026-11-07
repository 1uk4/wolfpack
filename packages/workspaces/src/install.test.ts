import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHomeChildWorkspace, createInstallLimiter, dependenciesLine, installDependencies, installEnv, locatePnpm, redactSecrets, makeTempRepo, repoOf, runInstallProcess,
  type InstallResult, type InstallRun, type InstallRunner, type RepoInfo, type TempRepo,
} from "./index.js";

let t: TempRepo;
beforeEach(() => { t = makeTempRepo("demo"); });
afterEach(() => t.cleanup());

const withLock = () => { t.commitFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"); };
const PNPM = { command: "/fake/bin/pnpm", args: [] as string[] };
const found = () => PNPM;

function exe(path: string, body = "#!/bin/sh\nexit 0\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("installDependencies", () => {
  it("runs the located pnpm with install --frozen-lockfile --prefer-offline in the worktree, 5 min, log outside the tree", async () => {
    withLock();
    const calls: InstallRun[] = [];
    const r = await installDependencies(t.dir, { runner: async (run) => { calls.push(run); return { code: 0, timedOut: false }; }, findPnpm: found });
    expect(r.status).toBe("installed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cwd: t.dir, command: "/fake/bin/pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"], timeoutMs: 5 * 60_000 });
    expect(calls[0]!.logPath.startsWith(join(t.dir, ".git"))).toBe(true);
    expect(r.logPath).toBe(calls[0]!.logPath);
  });

  it("puts the located command's prefix args (corepack pnpm) before the install args", async () => {
    withLock();
    const calls: InstallRun[] = [];
    await installDependencies(t.dir, { runner: async (run) => { calls.push(run); return { code: 0, timedOut: false }; }, findPnpm: () => ({ command: "/n/corepack", args: ["pnpm"] }) });
    expect(calls[0]).toMatchObject({ command: "/n/corepack", args: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"] });
  });

  it("gives the runner no WOLFPACK_* keys and CI=true", async () => {
    withLock();
    let env: Record<string, string | undefined> = {};
    await installDependencies(t.dir, {
      runner: async (run) => { env = run.env; return { code: 0, timedOut: false }; },
      findPnpm: found,
      env: { PATH: "/bin", HOME: "/h", WOLFPACK_TOKEN: "s", WOLFPACK_WOLF: "x", CI: "false" },
    });
    expect(Object.keys(env).filter((k) => k.startsWith("WOLFPACK_"))).toEqual([]);
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", CI: "true" });
  });

  it("silently skips without a pnpm-lock.yaml, and does not run", async () => {
    let ran = false;
    const r = await installDependencies(t.dir, { runner: async () => { ran = true; return { code: 0, timedOut: false }; }, findPnpm: found });
    expect(ran).toBe(false);
    expect(r).toMatchObject({ status: "skipped", reason: "no pnpm-lock.yaml: skipped install" });
  });

  it("fails (not skips) when the lockfile exists but pnpm is not found", async () => {
    withLock();
    let ran = false;
    const r = await installDependencies(t.dir, { runner: async () => { ran = true; return { code: 0, timedOut: false }; }, findPnpm: () => null });
    expect(ran).toBe(false);
    expect(r).toMatchObject({ status: "failed", cause: "pnpm-missing", reason: "pnpm not found; dependencies not installed" });
  });

  it("reports a non-zero exit as failed with the code and the last 15 log lines", async () => {
    withLock();
    const runner: InstallRunner = async (run) => {
      writeFileSync(run.logPath, Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
      return { code: 1, timedOut: false };
    };
    const r = await installDependencies(t.dir, { runner, findPnpm: found });
    expect(r).toMatchObject({ status: "failed", reason: "exit 1", cause: "exit" });
    expect(r.tail!.split("\n")).toHaveLength(15);
    expect(r.tail).toContain("line 40");
    expect(r.tail).not.toContain("line 25\n");
  });

  it("recognises a frozen-lockfile mismatch from the log", async () => {
    withLock();
    const runner: InstallRunner = async (run) => { writeFileSync(run.logPath, " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"\n"); return { code: 1, timedOut: false }; };
    expect((await installDependencies(t.dir, { runner, findPnpm: found })).cause).toBe("lockfile");
  });

  it("a log that merely mentions frozen-lockfile is a plain exit failure", async () => {
    withLock();
    const runner: InstallRunner = async (run) => { writeFileSync(run.logPath, "pnpm install --frozen-lockfile\nERR_PNPM_FETCH_404 not found\n"); return { code: 1, timedOut: false }; };
    expect((await installDependencies(t.dir, { runner, findPnpm: found })).cause).toBe("exit");
  });

  it("redacts secrets from the log tail before it reaches the brief", async () => {
    withLock();
    const runner: InstallRunner = async (run) => {
      writeFileSync(run.logPath, [
        "NPM_TOKEN=abc123secret",
        "api_key: hunter2value",
        "fetch https://user:p4ss@registry.example.com/x",
        "auth sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX",
        "gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        "plain line stays",
      ].join("\n") + "\n");
      return { code: 1, timedOut: false };
    };
    const r = await installDependencies(t.dir, { runner, findPnpm: found });
    for (const leak of ["abc123secret", "hunter2value", "p4ss", "ABCDEFGHIJKLMNOPQRSTUVWX", "ghp_ABCDEFGH"]) expect(r.tail).not.toContain(leak);
    expect(r.tail).toContain("plain line stays");
    expect(r.tail).toContain("registry.example.com");
  });

  it("marks a corepack run in the result", async () => {
    withLock();
    const r = await installDependencies(t.dir, { runner: async () => ({ code: 1, timedOut: false }), findPnpm: () => ({ command: "/n/corepack", args: ["pnpm"] }) });
    expect(r.viaCorepack).toBe(true);
    const direct = await installDependencies(t.dir, { runner: async () => ({ code: 1, timedOut: false }), findPnpm: found });
    expect(direct.viaCorepack).toBeUndefined();
  });

  it("reports a timeout as failed", async () => {
    withLock();
    const r = await installDependencies(t.dir, { runner: async () => ({ code: null, timedOut: true }), findPnpm: found, timeoutMs: 50 });
    expect(r).toMatchObject({ status: "failed", cause: "timeout" });
    expect(r.reason).toMatch(/timed out/);
  });

  it("turns a throwing runner into failed instead of throwing", async () => {
    withLock();
    const r = await installDependencies(t.dir, { runner: async () => { throw new Error("spawn exploded"); }, findPnpm: found });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("spawn exploded");
  });

  it("passes the signal to the runner; an abort gives failed/aborted", async () => {
    withLock();
    const ctl = new AbortController();
    let seen: AbortSignal | undefined;
    const runner: InstallRunner = (run) => new Promise((resolve) => {
      seen = run.signal;
      run.signal?.addEventListener("abort", () => resolve({ code: null, timedOut: false, aborted: true }));
    });
    const p = installDependencies(t.dir, { runner, findPnpm: found, signal: ctl.signal });
    await vi.waitFor(() => expect(seen).toBe(ctl.signal));
    ctl.abort();
    expect(await p).toMatchObject({ status: "failed", cause: "aborted" });
  });

  it("does not run at all when already aborted", async () => {
    withLock();
    const ctl = new AbortController();
    ctl.abort();
    let ran = false;
    const r = await installDependencies(t.dir, { runner: async () => { ran = true; return { code: 0, timedOut: false }; }, findPnpm: found, signal: ctl.signal });
    expect(ran).toBe(false);
    expect(r.cause).toBe("aborted");
  });

  it("runs at most `limit` installs at once; the rest wait for a slot", async () => {
    withLock();
    const limiter = createInstallLimiter(2);
    const release: Array<() => void> = [];
    let started = 0;
    const runner: InstallRunner = () => new Promise((resolve) => { started++; release.push(() => resolve({ code: 0, timedOut: false })); });
    const all = [1, 2, 3].map(() => installDependencies(t.dir, { runner, findPnpm: found, limiter }));
    await vi.waitFor(() => expect(started).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toBe(2);
    release[0]!();
    await vi.waitFor(() => expect(started).toBe(3));
    release[1]!(); release[2]!();
    expect((await Promise.all(all)).map((r) => r.status)).toEqual(["installed", "installed", "installed"]);
  });

  it("an abort while waiting for a slot never runs the install", async () => {
    withLock();
    const limiter = createInstallLimiter(1);
    let hold!: () => void;
    let ran = 0;
    const first = installDependencies(t.dir, { runner: () => new Promise((r) => { ran++; hold = () => r({ code: 0, timedOut: false }); }), findPnpm: found, limiter });
    await vi.waitFor(() => expect(ran).toBe(1));
    const ctl = new AbortController();
    const second = installDependencies(t.dir, { runner: async () => { ran++; return { code: 0, timedOut: false }; }, findPnpm: found, limiter, signal: ctl.signal });
    ctl.abort();
    expect((await second).cause).toBe("aborted");
    hold();
    await first;
    expect(ran).toBe(1);
  });
});

describe("installEnv", () => {
  it("drops WOLFPACK_*, token/secret/password/credential/key variables and provider settings, keeps NPM_TOKEN, NPM_CONFIG_* and the rest", () => {
    const out = installEnv({
      PATH: "/bin", HOME: "/h", KEYBOARD_LAYOUT: "us", NPM_TOKEN: "n", NPM_CONFIG_REGISTRY: "r", npm_config_cache: "c", NPM_CONFIG__authToken: "t",
      WOLFPACK_X: "1", SLACK_TOKEN: "1", TOKEN_FILE: "1", MY_SECRET: "1", AWS_SECRET_ACCESS_KEY: "1", AWS_ACCESS_KEY_ID: "1", STRIPE_API_KEY: "1", APIKEY_X: "1",
      DB_PASSWORD: "1", DB_PASSWD: "1", GOOGLE_CREDENTIALS: "1", SSH_PRIVATE_KEY: "1", SIGNING_KEY: "1", DATABASE_URL: "1", SSH_AUTH_SOCK: "1",
      ANTHROPIC_API_KEY: "1", ANTHROPIC_BASE_URL: "1", OPENAI_API_KEY: "1", OPENAI_ORG: "1", GITHUB_TOKEN: "1", GH_TOKEN: "1",
    });
    expect(Object.keys(out).sort()).toEqual(["CI", "HOME", "KEYBOARD_LAYOUT", "NPM_CONFIG_REGISTRY", "NPM_CONFIG__authToken", "NPM_TOKEN", "PATH", "npm_config_cache"]);
    expect(out.CI).toBe("true");
  });
});

describe("redactSecrets", () => {
  it("keeps ordinary text", () => {
    expect(redactSecrets("ERR_PNPM_OUTDATED_LOCKFILE  Cannot install\nhttps://registry.npmjs.org/x")).toBe("ERR_PNPM_OUTDATED_LOCKFILE  Cannot install\nhttps://registry.npmjs.org/x");
  });
  it.each([
    ["a JSON key", '{"apiKey": "abc123leak", "name": "x"}', "abc123leak", '"name": "x"'],
    ["a single-quoted key", "{'secretValue': 'abc123leak'}", "abc123leak", ""],
    ["a quoted value with spaces", 'PASSWORD="correct horse battery"', "horse", ""],
    ["a single-quoted value with spaces", "MY_SECRET='two words here'", "words", ""],
    ["a Bearer token", "Authorization: Bearer abcDEF123.456_xyz-789", "abcDEF123", "Authorization"],
    ["an AWS access key id", "key id AKIAIOSFODNN7EXAMPLE used", "AKIAIOSFODNN7EXAMPLE", "used"],
    ["a JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk end", "eyJzdWIi", "end"],
    ["userinfo without a colon", "git clone https://ghtoken123abc@github.com/o/r.git", "ghtoken123abc", "github.com/o/r.git"],
    ["userinfo with a colon", "fetch https://user:p4ss@registry.example.com/x", "p4ss", "registry.example.com/x"],
    ["a long sk- token", "auth sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX", "ABCDEFGHIJKLMNOPQRSTUVWX", "auth"],
    ["a ghp_ token", "gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ghp_ABCDEFGH", "gh"],
  ])("redacts %s", (_n, input, leak, kept) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(leak);
    if (kept) expect(out).toContain(kept);
  });
});

describe("locatePnpm", () => {
  let home: string;
  beforeEach(() => { home = join(t.base, "home"); mkdirSync(home); });
  const opts = (extra: Record<string, unknown> = {}) => ({ path: "", home, systemDirs: [join(t.base, "fixed1"), join(t.base, "fixed2")], execPath: join(t.base, "node", "bin", "node"), ...extra });

  it("prefers PATH over the fixed dirs", () => {
    const onPath = exe(join(t.base, "pathdir", "pnpm"));
    exe(join(t.base, "fixed1", "pnpm"));
    expect(locatePnpm(opts({ path: join(t.base, "pathdir") }))).toEqual({ command: onPath, args: [] });
  });
  it("falls back through the fixed dirs in order, then the home dirs", () => {
    const second = exe(join(t.base, "fixed2", "pnpm"));
    expect(locatePnpm(opts())).toEqual({ command: second, args: [] });
    const first = exe(join(t.base, "fixed1", "pnpm"));
    expect(locatePnpm(opts())).toEqual({ command: first, args: [] });
  });
  it("looks in ~/Library/pnpm and ~/.local/share/pnpm after the system dirs", () => {
    const lib = exe(join(home, "Library", "pnpm", "pnpm"));
    expect(locatePnpm(opts())).toEqual({ command: lib, args: [] });
    const share = exe(join(home, ".local", "share", "pnpm", "pnpm"));
    exe(join(t.base, "fixed2", "pnpm"));
    expect(locatePnpm(opts())).toEqual({ command: join(t.base, "fixed2", "pnpm"), args: [] }); // system dirs come first
    expect(share).toContain(".local/share/pnpm");
  });
  it("uses corepack next to node as the last resort", () => {
    const corepack = exe(join(t.base, "node", "bin", "corepack"));
    expect(locatePnpm(opts())).toEqual({ command: corepack, args: ["pnpm"] });
  });
  it("ignores a directory named pnpm", () => {
    mkdirSync(join(t.base, "fixed1", "pnpm"), { recursive: true });
    expect(locatePnpm(opts())).toBeNull();
  });
  it("is null when nothing is found", () => {
    expect(locatePnpm(opts())).toBeNull();
  });
});

describe("runInstallProcess", () => {
  const base = (over: Partial<InstallRun>): InstallRun => ({ cwd: t.base, command: process.execPath, args: [], timeoutMs: 10_000, logPath: join(t.base, "l.log"), env: { PATH: process.env.PATH }, ...over });

  it("kills the whole process group on timeout (a grandchild too) and keeps the output in the log", async () => {
    const pidfile = join(t.base, "pid");
    const logPath = join(t.base, "out.log");
    const t0 = Date.now();
    const r = await runInstallProcess(base({ command: "sh", args: ["-c", `echo started; sleep 60 & echo $! > ${pidfile}; wait`], timeoutMs: 600, logPath }));
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const grandchild = Number(readFileSync(pidfile, "utf8").trim());
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false));
    expect(readFileSync(logPath, "utf8")).toContain("started");
  });
  it("kills the group on abort and reports aborted", async () => {
    const pidfile = join(t.base, "pid2");
    const ctl = new AbortController();
    const p = runInstallProcess(base({ command: "sh", args: ["-c", `sleep 60 & echo $! > ${pidfile}; wait`], signal: ctl.signal }));
    await vi.waitFor(() => expect(existsSync(pidfile) && readFileSync(pidfile, "utf8").trim() !== "").toBe(true));
    ctl.abort();
    expect(await p).toMatchObject({ aborted: true });
    await vi.waitFor(() => expect(alive(Number(readFileSync(pidfile, "utf8").trim()))).toBe(false));
  });
  it("returns the exit code", async () => {
    expect(await runInstallProcess(base({ args: ["-e", "process.exit(3)"] }))).toMatchObject({ code: 3, timedOut: false });
  });
  it("passes only the given env", async () => {
    const logPath = join(t.base, "env.log");
    await runInstallProcess(base({ args: ["-e", "console.log(Object.keys(process.env).includes('SECRET_X') + ':' + process.env.CI)"], env: { PATH: process.env.PATH, CI: "true" }, logPath }));
    expect(readFileSync(logPath, "utf8").trim()).toBe("false:true");
  });
  it("reports a missing binary as a failure code, not a throw", async () => {
    expect((await runInstallProcess(base({ command: join(t.base, "no-such-binary") }))).code).not.toBe(0);
  });
});

describe("dependenciesLine", () => {
  const failed = (over: Partial<InstallResult>): InstallResult => ({ status: "failed", reason: "exit 1", cause: "exit", ms: 10, logPath: "/x/log", ...over });
  it("says installed with seconds", () => {
    expect(dependenciesLine({ status: "installed", reason: "", ms: 6200 })).toBe("Dependencies: installed with pnpm in 6.2 s");
  });
  it("says skipped with the reason", () => {
    expect(dependenciesLine({ status: "skipped", reason: "no pnpm-lock.yaml: skipped install", ms: 0 })).toBe("Dependencies: no pnpm-lock.yaml: skipped install");
  });
  it("failed: reason, log, run pnpm install yourself, and the log tail", () => {
    const line = dependenciesLine(failed({ tail: "boom 1\nboom 2" }));
    expect(line.split("\n")[0]).toBe("Dependencies: install failed (exit 1, log: /x/log); run `pnpm install` yourself");
    expect(line).toContain("boom 1\nboom 2");
  });
  it("lockfile mismatch: says the lockfile is out of date, not 'run pnpm install'", () => {
    const line = dependenciesLine(failed({ cause: "lockfile" }));
    expect(line).toContain("the lockfile is out of date with package.json");
    expect(line).not.toContain("run `pnpm install` yourself");
  });
  it("a corepack run says so", () => {
    expect(dependenciesLine(failed({ viaCorepack: true })).split("\n")[0]).toContain("(via corepack)");
    expect(dependenciesLine(failed({})).split("\n")[0]).not.toContain("corepack");
  });
  it("pnpm missing: no advice to run pnpm install", () => {
    const line = dependenciesLine(failed({ cause: "pnpm-missing", reason: "pnpm not found; dependencies not installed", logPath: undefined }));
    expect(line).toBe("Dependencies: pnpm not found; dependencies not installed");
  });
});

describe("worktree creation with the install", () => {
  it("leaves the worktree in place when the install fails, and the log is outside the tracked tree", async () => {
    t.commitFile("pnpm-lock.yaml", "x\n");
    const repo = (await repoOf(t.dir)) as RepoInfo;
    const ws = await createHomeChildWorkspace({ root: t.root, repo, childSlug: "a-1", baseDir: t.dir });
    const r = await installDependencies(ws.path, { runner: async (run) => { writeFileSync(run.logPath, "x"); return { code: 1, timedOut: false }; }, findPnpm: found });
    expect(r.status).toBe("failed");
    expect(existsSync(join(ws.path, "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(r.logPath!)).toBe(true);
    expect(t.git(["status", "--porcelain"], ws.path)).toBe("");
  });
});
