/**
 * `wolfpack test`: run vitest with a result cache and, for agents, a host-wide queue.
 * Agents queue (a few runs at once, lowered priority, capped workers); the owner's runs skip the queue but still use
 * the cache. Vitest is resolved from the repo and run with node, never through npx or a package manager, so it works
 * under npm and pnpm alike.
 */
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { setPriority, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openCache, cacheKey } from "./test-cache.js";
import { formatWait, openQueue, QueueCancelled, QUEUE_TIMEOUT_MS, type Ticket } from "./test-queue.js";

export const EXIT_QUEUE_TIMEOUT = 75;
export const EXIT_RUN_TIMEOUT = 124;
export const RUN_TIMEOUT_MS = 20 * 60_000;
export const KILL_GRACE_MS = 10_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNUM: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

export interface TestSettings {
  slots: number;
  workersPerRun: number;
}

function positiveInt(name: string, v: unknown): number {
  const n = typeof v === "string" ? (/^\d+$/.test(v.trim()) ? Number(v) : NaN) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new Error(`${name} must be an integer of at least 1 (got ${JSON.stringify(v)})`);
  return n;
}

/** tests.slots / tests.workersPerRun from ~/.wolfpack/config.yaml, overridden by WOLFPACK_TEST_SLOTS / WOLFPACK_TEST_WORKERS. */
export function testSettings(cfg: { tests?: { slots?: unknown; workersPerRun?: unknown } }, env: NodeJS.ProcessEnv): TestSettings {
  const slots = env.WOLFPACK_TEST_SLOTS ?? cfg.tests?.slots ?? 2;
  const workers = env.WOLFPACK_TEST_WORKERS ?? cfg.tests?.workersPerRun ?? 2;
  return { slots: positiveInt("tests.slots", slots), workersPerRun: positiveInt("tests.workersPerRun", workers) };
}

/** Agent shells carry WOLFPACK_AGENT_RUN=1 or are subagent children; WOLFPACK_TEST_BYPASS is the escape hatch. */
export function isAgentRun(env: NodeJS.ProcessEnv): boolean {
  if (env.WOLFPACK_TEST_BYPASS) return false;
  return env.WOLFPACK_AGENT_RUN === "1" || Boolean(env.PI_SUBAGENT_AGENT);
}

const USAGE = "Usage: wolfpack test [run|related] [paths…] [-t <name>] [--no-cache]";

/**
 * Allow-list parsing of `wolfpack test …` (argv may still start with "test").
 * With `ctx`, path arguments are taken relative to the caller's directory and rewritten relative to the repo root
 * (vitest runs from the root): every `related` file; for `run`, a word that contains `/`, ends in a file extension or names an existing path at the caller's cwd (anything
 * else is a vitest filter and stays as typed). A path outside the repo is refused.
 */
export function parseTestArgs(argv: string[], ctx?: { cwd: string; root: string }): { args: string[]; noCache: boolean } {
  const rest = argv[0] === "test" ? argv.slice(1) : [...argv];
  let noCache = false;
  const words: Array<{ text: string; value: boolean }> = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--no-cache") noCache = true;
    else if (a === "-t" || a === "--testNamePattern") {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${a} needs a value. ${USAGE}`);
      words.push({ text: a, value: false }, { text: v, value: false });
    } else if (a.startsWith("-")) throw new Error(`unknown argument "${a}". ${USAGE}`);
    else words.push({ text: a, value: true });
  }
  const mode = words[0]?.value && (words[0].text === "related" || words[0].text === "run") ? words.shift()!.text : "run";
  const out = words.map((w) => {
    if (!w.value || !ctx) return w.text;
    const abs = resolve(ctx.cwd, w.text);
    // (in run mode a bare word is a vitest filter; it is a path only if it looks like one or exists at the caller's cwd)
    if (mode === "run" && !/\/|\.[A-Za-z0-9]+$/.test(w.text) && !existsSync(abs)) return w.text;
    const rel = relative(ctx.root, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`"${w.text}" is outside the repo (${ctx.root}). ${USAGE}`);
    return rel || ".";
  });
  return { args: mode === "related" ? ["related", ...out, "--run"] : [mode, ...out], noCache };
}

export interface RunOptions {
  /** The repo root: vitest is resolved from here and the cache key is computed over its git state. */
  root: string;
  /** vitest arguments (`run …` or `related … --run`). */
  args: string[];
  noCache?: boolean;
  env?: NodeJS.ProcessEnv;
  settings: TestSettings;
  queueDir?: string;
  cacheDir?: string;
  /** vitest's bin script; default: resolved from `root`. */
  vitestBin?: string;
  vitestVersion?: string;
  log?: (line: string) => void;
  stdio?: "inherit" | "ignore";
  signals?: EventEmitter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  queueTimeoutMs?: number;
  runTimeoutMs?: number;
  /** After SIGTERM (timeout or signal), how long before the group gets SIGKILL (default 10 s). */
  killGraceMs?: number;
}

function resolveVitest(root: string): { bin: string; version: string } {
  const pkgPath = createRequire(join(root, "package.json")).resolve("vitest/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
  if (!rel) throw new Error("vitest has no bin entry");
  return { bin: resolve(dirname(pkgPath), rel), version: pkg.version };
}

/** Run the tests; resolves to the process exit code. */
export async function runTests(o: RunOptions): Promise<number> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((l: string) => console.error(l));
  const signals = o.signals ?? process;
  const now = o.now ?? Date.now;
  const grace = o.killGraceMs ?? KILL_GRACE_MS;
  const resolved = o.vitestBin ? { bin: o.vitestBin, version: o.vitestVersion ?? "unknown" } : resolveVitest(o.root);

  // Signals first: from here on a SIGINT/SIGTERM/SIGHUP is never lost, whatever step we are in.
  let interrupted: string | undefined;
  let onInterrupt: (sig: string) => void = () => {};
  const wake = new Promise<"signal">((r) => {
    const prev = onInterrupt;
    onInterrupt = (s) => {
      prev(s);
      r("signal");
    };
  });
  const handlers = SIGNALS.map((s) => {
    const h = () => {
      interrupted = s;
      onInterrupt(s);
    };
    signals.on(s, h);
    return [s, h] as const;
  });
  const cleanupHandlers = () => handlers.forEach(([s, h]) => signals.off(s, h));
  const interruptCode = () => 128 + SIGNUM[interrupted!]!;

  // 1. The cache: a pass for the same files, command and environment needs no slot and no child.
  const cache = o.noCache ? undefined : openCache({ ...(o.cacheDir ? { dir: o.cacheDir } : {}), now });
  const keyNow = () => {
    try {
      return cacheKey({ root: o.root, args: o.args, vitestVersion: resolved.version, env });
    } catch {
      return undefined; // not a git checkout: no cache
    }
  };
  const key = cache ? keyNow() : undefined;
  const hit = cache && key ? cache.lookup(key) : undefined;
  if (hit) {
    cleanupHandlers();
    log(`PASS (cached: same files, command and environment passed on this host at ${new Date(hit.at).toISOString()})`);
    return 0;
  }

  const queue = isAgentRun(env)
    ? openQueue({ ...(o.queueDir ? { dir: o.queueDir } : {}), slots: o.settings.slots, now, ...(o.sleep ? { sleep: o.sleep } : {}) })
    : undefined;
  let ticket: Ticket | undefined;
  const report = mkdtempSync(join(tmpdir(), "wolfpack-test-"));
  const reportFile = join(report, "report.json");
  try {
    // 2. Agents wait their turn.
    if (queue) {
      try {
        ticket = await queue.enqueue({ wolf: env.WOLF_NAME || env.PI_SUBAGENT_AGENT || "agent", cwd: o.root, args: o.args }, () => interrupted !== undefined);
      } catch (e) {
        if (e instanceof QueueCancelled) return interruptCode();
        throw e;
      }
      if (interrupted) return interruptCode();
      const t = ticket;
      const timeoutMs = o.queueTimeoutMs ?? QUEUE_TIMEOUT_MS;
      let last = "";
      const turn = queue.waitTurn(t, {
        timeoutMs,
        onWait: (st) => {
          const line = formatWait(st, now());
          if (line !== last) log(line);
          last = line;
        },
      });
      turn.catch(() => {}); // after an interrupt the ticket is gone and the loop ends with an error nobody reads
      const verdict = await Promise.race([turn, wake]);
      if (verdict === "signal") return interruptCode();
      if (!verdict.admitted) {
        log(`wolfpack test: gave up after ${Math.round(timeoutMs / 60_000)} minutes waiting for a test slot. Running now: ${verdict.holders.map((h) => `${h.wolf} in ${h.cwd}`).join("; ") || "(nobody; try again)"}. Try again later, or ask the owner.`);
        return EXIT_QUEUE_TIMEOUT;
      }
    }

    // 3. Run vitest at a lowered priority, in its own process group so a signal reaches its workers.
    try {
      // (this lowers the runner's own priority too, for the rest of its life: it only waits on the child, so that is fine)
      setPriority(0, 10);
    } catch {
      /* best effort */
    }
    const args = [resolved.bin, ...o.args, `--maxWorkers=${o.settings.workersPerRun}`, ...(cache ? ["--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`] : [])];
    const child = spawn(process.execPath, args, { cwd: o.root, env, stdio: o.stdio ?? "inherit", detached: true });
    if (ticket && child.pid) await queue?.setChild(ticket, { pgid: child.pid });
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        /* gone */
      }
    };
    let exited = false;
    let hardKill: NodeJS.Timeout | undefined;
    // SIGTERM now, SIGKILL if the group is still there after the grace period
    const stop = (sig: NodeJS.Signals) => {
      killGroup(sig);
      hardKill ??= setTimeout(() => !exited && killGroup("SIGKILL"), grace);
    };
    let timedOut = false;
    onInterrupt = (s) => stop(s as NodeJS.Signals);
    if (interrupted) stop(interrupted as NodeJS.Signals);
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
    }, o.runTimeoutMs ?? RUN_TIMEOUT_MS);
    const code = await new Promise<number>((res) => {
      child.on("error", (e) => {
        log(`wolfpack test: could not start vitest: ${e.message}`);
        res(1);
      });
      child.on("close", (c, sig) => res(c ?? (sig ? 128 + (SIGNUM[sig] ?? 1) : 1)));
    });
    exited = true;
    clearTimeout(timer);
    clearTimeout(hardKill);
    killGroup("SIGKILL"); // stragglers of the group
    if (interrupted) return interruptCode();
    if (timedOut) {
      log(`wolfpack test: the run took longer than ${Math.round((o.runTimeoutMs ?? RUN_TIMEOUT_MS) / 60_000)} minutes and was stopped`);
      return EXIT_RUN_TIMEOUT;
    }

    // 4. Remember a pass, together with the test files that actually ran, but only if the tree is exactly what it was
    // when the key was made (it may have been edited while we waited or ran).
    if (cache && key && code === 0 && keyNow() === key) {
      try {
        const rep = JSON.parse(readFileSync(reportFile, "utf8")) as { testResults?: Array<{ name: string }> };
        const files = (rep.testResults ?? []).map((r) => r.name);
        if (files.length) cache.store(key, { status: "pass", files, args: o.args });
      } catch {
        /* no report: nothing to remember */
      }
    }
    return code;
  } finally {
    if (ticket) await queue?.release(ticket);
    cleanupHandlers();
    rmSync(report, { recursive: true, force: true });
  }
}
