/**
 * Pack health: the /healthz body every service answers, and the live probe that grades it.
 * Pure (global fetch + timers only) so the console server and the browser bundle can both import it.
 * The event-loop lag monitor lives in ./health-lag.ts (node-only).
 */
import type { CommandKind } from "./command.js";

/** Body of GET /healthz on hubd, workerd and wolfd. Services may add fields (workerd keeps `wolves`, `kb`, `hub`). */
export interface HealthBody {
  ok: boolean;
  /** Which service answered: "hubd" | "workerd" | "wolfd". */
  service?: string;
  version?: string;
  /** os.hostname() of the machine the service runs on. Additive: older services omit it. */
  host?: string;
  /** Machine name (WOLFPACK_MACHINE, else hostname, normalised). Additive: older services omit it. */
  machine?: string;
  uptimeS?: number;
  /** Event-loop delay over the service's rolling window (about the last 20 s), ms beyond the sampler's own interval: p99 and max. */
  lag?: { p99Ms: number; maxMs: number };
  [extra: string]: unknown;
}

/** One host in hubd's /healthz `hosts` summary: the hub's view of the pack (registry + link presence). */
export interface HubHealthHost {
  /** The host id the worker token was paired with (`hubd pair --host-id`); workerd's /healthz names it as `hubHostId`. */
  id: string;
  /** The worker token's label: the operator's `hubd pair --label`, else the os.hostname() workerd sent when it paired. */
  label?: string;
  presence: "online" | "asleep" | "offline";
  /** The machine this host's worker reported in its hello (several host ids can share one machine). Absent: older worker, or never connected. */
  machine?: string;
  /** Command kinds this host's worker advertised in its hello. Absent: older worker, offline, or none. */
  commands?: CommandKind[];
  /** When presence last changed, as seen by this hubd process (absent: unchanged since it started). */
  since?: string;
  wolves: { name: string; status: "online" | "offline" }[];
}
/** Caps on the hubd /healthz summary (it is unauthenticated). */
export const HUB_HEALTH_MAX_HOSTS = 64;
export const HUB_HEALTH_MAX_WOLVES = 64;

export type HealthStatus = "ok" | "degraded" | "down";

export interface ProbeResult {
  status: HealthStatus;
  /** Wall time of the request as measured; a timed-out probe reports the real elapsed time (slightly over the timeout). */
  responseMs: number;
  /** Event-loop p99 reported by the service; undefined when it did not answer or reports none. */
  lagMs?: number;
  checkedAt: string;
  error?: string;
  /** The parsed body when the service answered. */
  body?: HealthBody;
}

/** Slower than this = degraded. */
export const DEGRADED_RESPONSE_MS = 1_000;
/** Event-loop p99 above this = degraded. */
export const DEGRADED_LAG_MS = 200;
/** No answer within this = down (a frozen event loop looks exactly like this). */
export const PROBE_TIMEOUT_MS = 3_000;

export interface ProbeOptions {
  timeoutMs?: number;
  degradedResponseMs?: number;
  degradedLagMs?: number;
  headers?: Record<string, string>;
  /** The `service` the body must name ("hubd" | "workerd" | "wolfd"); a different one is down ("wrong service"): something else answers on that port. */
  expectService?: string;
  /** Clock (tests). */
  now?: () => number;
  fetch?: typeof fetch;
}

/** GET `url` (a /healthz URL) with a hard timeout and grade it. Never throws. */
export async function probeHealth(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const start = now();
  // One clock read for the end time, so responseMs and checkedAt agree.
  const done = (r: Omit<ProbeResult, "responseMs" | "checkedAt">, end = now()): ProbeResult => ({ ...r, responseMs: end - start, checkedAt: new Date(end).toISOString() });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await (opts.fetch ?? fetch)(url, { signal: ctl.signal, headers: opts.headers });
    const text = await res.text(); // inside the timeout: a body that never ends is also "frozen"
    if (!res.ok) return done({ status: "down", error: `HTTP ${res.status}` });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return done({ status: "down", error: "unparseable health body" });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return done({ status: "down", error: "unparseable health body" });
    const body = parsed as HealthBody;
    if (opts.expectService !== undefined && body.service !== opts.expectService) return done({ status: "down", error: "wrong service", body });
    const end = now();
    const lagMs = typeof body.lag?.p99Ms === "number" ? body.lag.p99Ms : undefined;
    const slow = end - start > (opts.degradedResponseMs ?? DEGRADED_RESPONSE_MS) || (lagMs ?? 0) > (opts.degradedLagMs ?? DEGRADED_LAG_MS) || body.ok === false;
    return done({ status: slow ? "degraded" : "ok", ...(lagMs === undefined ? {} : { lagMs }), body }, end);
  } catch (e) {
    if (ctl.signal.aborted) return done({ status: "down", error: `no answer within ${timeoutMs}ms` });
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    return done({ status: "down", error: cause ?? (e instanceof Error ? e.message : String(e)) });
  } finally {
    clearTimeout(timer);
  }
}
