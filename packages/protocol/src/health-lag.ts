import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { HealthBody } from "./health.js";

export interface LagMonitor {
  /**
   * Event-loop delay (ms) over the rolling window: the worst per-interval p99 and the max, beyond the sampler's own resolution.
   * Read-only: any number of probers see the same window, and a spike stays visible until it ages out of the ring.
   *
   * `p99Ms` is the worst one-second p99 in the ring, not the p99 of the whole window: it skews pessimistic, and a second with one
   * long stall and few samples puts it close to `maxMs`.
   * Recovery lags by the ring length: a single 200 ms stall keeps the service graded degraded for up to ~windowMs (20 s by default)
   * after the loop is healthy again, until that slot ages out.
   */
  sample(): { p99Ms: number; maxMs: number };
  stop(): void;
}

export interface LagMonitorOptions {
  /** Histogram sampling resolution, ms. Subtracted from every reading: an idle loop reports ~0, not ~resolution. */
  resolutionMs?: number;
  /** How often the histogram is folded into the ring, ms. */
  intervalMs?: number;
  /** Ring length, ms (intervalMs slots of it). */
  windowMs?: number;
}

const ms = (ns: number, resolutionMs: number): number => Math.max(0, Math.round(ns / 1e4) / 100 - resolutionMs);

/**
 * Continuous event-loop delay monitor (node-only) with a rolling window: every `intervalMs` the histogram's p99/max go into a ring
 * of `windowMs / intervalMs` slots and the histogram resets. sample() reports the worst over the ring plus the interval in progress,
 * so a 300 ms freeze shows up on the very next probe and on every probe for the next ~windowMs.
 * The window p99 is the worst per-interval p99 (an upper bound of the true window p99), which is what a health light wants.
 * The timer is unref'd: the monitor never keeps a process alive.
 */
export function createLagMonitor(opts: LagMonitorOptions = {}): LagMonitor {
  const resolutionMs = opts.resolutionMs ?? 20;
  const intervalMs = opts.intervalMs ?? 1_000;
  const slots = Math.max(1, Math.round((opts.windowMs ?? 20_000) / intervalMs));
  const h = monitorEventLoopDelay({ resolution: resolutionMs });
  h.enable();
  const ring: { p99Ms: number; maxMs: number }[] = [];
  const current = () => (h.count > 0 ? { p99Ms: ms(h.percentile(99), resolutionMs), maxMs: ms(h.max, resolutionMs) } : { p99Ms: 0, maxMs: 0 });
  const timer = setInterval(() => {
    ring.push(current());
    if (ring.length > slots) ring.shift();
    h.reset();
  }, intervalMs);
  timer.unref();
  return {
    sample() {
      let p99Ms = 0;
      let maxMs = 0;
      for (const s of [...ring, current()]) {
        p99Ms = Math.max(p99Ms, s.p99Ms);
        maxMs = Math.max(maxMs, s.maxMs);
      }
      return { p99Ms, maxMs };
    },
    stop() {
      clearInterval(timer);
      h.disable();
    },
  };
}

/**
 * The release version a service reports: the first non-empty VERSION stamp in `stamps` (written at build time by
 * scripts/release-version.mjs from the `<component>/vX.Y.Z` tag: "X.Y.Z" or "X.Y.Z+<sha>"), else `<package.json version>-dev`
 * (tests, unbuilt checkouts: a -dev version never prompts an update), else undefined. Read once at startup.
 */
export function stampedVersion(stamps: URL[], pkg: URL, release: { releaseFile?: string; head?: string } = {}): string | undefined {
  for (const s of stamps) {
    try {
      const v = readFileSync(/*turbopackIgnore: true*/ s, "utf8").trim();
      if (v) return v;
    } catch {
      /* not stamped here */
    }
  }
  const rel = runtimeReleaseVersion(pkg, release);
  if (rel) return rel;
  const v = packageVersion(pkg);
  return v ? `${v}-dev` : undefined;
}

export const DEFAULT_SUBSCRIPTION_FILE = "/var/lib/wolfpack-subscription/subscription.json";

/**
 * The subscription file this machine's updater reads: `WOLFPACK_SUBSCRIPTION_FILE` if set, else ~/.wolfpack/release-channel.json on a Mac
 * (scripts/auto-update-mac.mjs), else the sfo-01 path. Platform and home are injectable for tests.
 */
export function subscriptionFile(env: Record<string, string | undefined> = process.env, platform: string = process.platform, home: string = homedir()): string {
  return env.WOLFPACK_SUBSCRIPTION_FILE?.trim() || (platform === "darwin" ? join(home, ".wolfpack", "release-channel.json") : DEFAULT_SUBSCRIPTION_FILE);
}

/**
 * The release channel this machine follows, from the subscription file the updater reads (`WOLFPACK_SUBSCRIPTION_FILE`, else the sfo-01 path,
 * else ~/.wolfpack/release-channel.json on a Mac). No file at all: "stable". A file that exists but cannot be read or parsed: undefined.
 */
export function readMachineChannel(env: Record<string, string | undefined> = process.env): "stable" | "main" | undefined {
  const file = subscriptionFile(env);
  let text: string;
  try {
    text = readFileSync(/*turbopackIgnore: true*/ file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "stable" : undefined;
  }
  try {
    const c = (JSON.parse(text) as { channel?: unknown } | null)?.channel;
    return c === "main" ? "main" : "stable";
  } catch {
    return undefined;
  }
}

const COMPONENT_OF_PACKAGE: Record<string, string> = { "@wolfpack/console": "console", "@wolfpack/hubd": "hubd", "@wolfpack/workerd": "workerd", "@wolfpack/harness": "wolfd" };

/**
 * The release version of a checkout built from a published commit (the Mac on the main channel): scripts/runtime-update.mjs writes
 * ~/.wolfpack/runtime-release.json `{sha, channel, versions:{console,hubd,workerd,wolfd}}` (or WOLFPACK_RUNTIME_RELEASE_FILE) when it checks out
 * the manifest's sha. It applies only while that sha is the checkout's HEAD; otherwise (or without the file) undefined and the caller keeps `-dev`.
 * It runs `git rev-parse` synchronously, so callers cache the result at startup and never call it per request.
 */
function runtimeReleaseVersion(pkg: URL, o: { releaseFile?: string; head?: string }): string | undefined {
  try {
    const file = o.releaseFile ?? (process.env.WOLFPACK_RUNTIME_RELEASE_FILE?.trim() || join(homedir(), ".wolfpack", "runtime-release.json"));
    const rel = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as { sha?: unknown; versions?: Record<string, unknown> };
    const name = (JSON.parse(readFileSync(/*turbopackIgnore: true*/ pkg, "utf8")) as { name?: unknown }).name;
    const component = typeof name === "string" ? COMPONENT_OF_PACKAGE[name] : undefined;
    const version = component ? rel.versions?.[component] : undefined;
    if (typeof rel.sha !== "string" || typeof version !== "string" || !version) return undefined;
    const head = o.head ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirname(fileURLToPath(pkg)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    return head === rel.sha ? version : undefined;
  } catch {
    return undefined;
  }
}

/** `version` from the package.json at `url` (e.g. `new URL("../package.json", import.meta.url)`); undefined when unreadable. */
export function packageVersion(url: URL): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(/*turbopackIgnore: true*/ url, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The machine this process runs on: `WOLFPACK_MACHINE` if set, else the OS hostname; lowercased, trimmed, a trailing `.local` dropped. */
export function machineName(env: Record<string, string | undefined> = process.env, host: () => string = hostname): string {
  return normaliseMachine(env.WOLFPACK_MACHINE) ?? normaliseMachine(host()) ?? "";
}

const MACHINE_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * THE machine-name rule, used by workerd, hubd and the console: trim, lowercase, keep the first dot-label (drops `.local`, `sfo.01` -> `sfo`),
 * then require a hostname label (letters, digits, `-`, at most 63). Anything else (empty, `my_box`) is undefined.
 */
export function normaliseMachine(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const label = raw.trim().toLowerCase().split(".")[0] ?? "";
  return MACHINE_LABEL.test(label) ? label : undefined;
}

/** Standard fields of a /healthz body. `lag` covers the monitor's rolling window (see createLagMonitor); `host` is os.hostname(). */
export function baseHealth(service: string, monitor: LagMonitor, version?: string): HealthBody {
  return { ok: true, service, host: hostname(), machine: machineName(), ...(version ? { version } : {}), uptimeS: Math.round(process.uptime()), lag: monitor.sample() };
}
