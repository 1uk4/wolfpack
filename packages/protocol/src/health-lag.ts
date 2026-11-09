import { readFileSync } from "node:fs";
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
export function stampedVersion(stamps: URL[], pkg: URL): string | undefined {
  for (const s of stamps) {
    try {
      const v = readFileSync(s, "utf8").trim();
      if (v) return v;
    } catch {
      /* not stamped here */
    }
  }
  const v = packageVersion(pkg);
  return v ? `${v}-dev` : undefined;
}

/** `version` from the package.json at `url` (e.g. `new URL("../package.json", import.meta.url)`); undefined when unreadable. */
export function packageVersion(url: URL): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(url, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Standard fields of a /healthz body. `lag` covers the monitor's rolling window (see createLagMonitor). */
export function baseHealth(service: string, monitor: LagMonitor, version?: string): HealthBody {
  return { ok: true, service, ...(version ? { version } : {}), uptimeS: Math.round(process.uptime()), lag: monitor.sample() };
}
