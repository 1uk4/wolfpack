import type { InventoryEntry } from "@wolfpack/protocol";
import { baseHealth, createLagMonitor, machineName, normaliseMachine, readMachineChannel, type LagMonitor } from "@wolfpack/protocol/health-lag";
import { HUB_HEALTH_MAX_HOSTS, HUB_HEALTH_MAX_WOLVES, type HealthBody, type CommandKind, type HubHealthHost, type LinkPresence } from "@wolfpack/protocol";
import { hubVersion } from "./settings.js";

/**
 * GET /healthz for hubd. Unauthenticated on purpose: it leaks liveness numbers, the package version, and the pack summary
 * (`hosts`: host ids, pairing labels, wolf names and presence, which the console already shows elsewhere), and a probe must
 * work with no token. Touches no KB or disk per request: the lag monitor is a rolling in-memory window, the version is read
 * once and cached, and the summary is cached (see createPackSummary).
 */
export interface HubHealth {
  body(): HealthBody;
  /** hubd's own inventory entry (version, channel, uptime, lag). */
  self(): InventoryEntry;
  stop(): void;
}

const PUBLIC_COMMANDS: ReadonlySet<string> = new Set<CommandKind>(["wolves.restart", "workerd.restart", "logs.fetch"]);

export function createHubHealth(hosts?: () => HubHealthHost[]): HubHealth {
  const monitor: LagMonitor = createLagMonitor();
  const channel = readMachineChannel();
  const env = Number(process.env.HUBD_LOOP_STALL_MS);
  const stall = createStallWatch({ thresholdMs: env > 0 ? env : DEFAULT_STALL_MS });
  return {
    body: () => ({ ...baseHealth("hubd", monitor, hubVersion()), ...(hosts ? { hosts: hosts() } : {}) }),
    self: () => ({ machine: machineName(), kind: "hubd", id: "hubd", version: hubVersion(), ...(channel ? { channel } : {}), uptimeS: Math.round(process.uptime()), lagMs: Math.round(monitor.sample().p99Ms) }),
    stop: () => { monitor.stop(); stall.stop(); },
  };
}

export const DEFAULT_STALL_MS = 5_000;

export interface StallWatchOptions {
  /** Warn when a tick arrives more than this many ms later than scheduled. Default 5000 (env HUBD_LOOP_STALL_MS). */
  thresholdMs?: number;
  /** Tick period, ms; also the rate limit: at most one warning per tick. */
  intervalMs?: number;
  now?: () => number;
  warn?: (line: string) => void;
}

/**
 * Logs one warning line when the event loop stalls: a timer scheduled every `intervalMs` fires late by more than `thresholdMs`.
 * A stall surfaces once, when it ends (the late tick), so a long stall never floods the journal. What was in flight is not
 * logged: hubd keeps no cheap counter of curator or Work API reads in progress. The timer is unref'd.
 */
export function createStallWatch(opts: StallWatchOptions = {}): { tick(): void; stop(): void } {
  const threshold = opts.thresholdMs ?? DEFAULT_STALL_MS;
  const interval = opts.intervalMs ?? 1_000;
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((l: string) => console.error(l));
  let last = now();
  const tick = () => {
    const t = now();
    const lag = t - last - interval;
    last = t;
    if (lag > threshold) warn(`${new Date(t).toISOString()} hubd: event loop stalled for ${Math.round(lag)} ms (threshold ${threshold} ms)`);
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

/** A pairing label is sent on /healthz only when it looks like a hostname. */
const HOSTNAME_LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;

export interface PackSummarySource {
  /** Registry hosts and wolves (in memory). */
  hosts: () => { name: string }[];
  wolves: () => { name: string; host?: string; status?: string }[];
  presence: (hostId: string) => LinkPresence;
  /** The machine a host reported in its hello, when it did. */
  machine?: (hostId: string) => string | undefined;
  /** Command kinds the host advertised in its hello (empty: older worker or offline). */
  commands?: (hostId: string) => readonly CommandKind[];
  /** Worker token label per host id (reads the token file: called only when `labelsDirty` was signalled). */
  labels: () => Map<string, string>;
  now?: () => number;
  /** Cache lifetime (ms). Presence and registry changes invalidate sooner. */
  ttlMs?: number;
}

export interface PackSummary {
  hosts(): HubHealthHost[];
  /** Presence of a host changed: stamp `since` and drop the cache. */
  presenceChanged(hostId: string): void;
  /** The registry changed: drop the cache. */
  registryChanged(): void;
  /** The token file changed: re-read labels on the next build. */
  labelsChanged(): void;
}

/** The hub's view of the pack for /healthz: every registry host (plus hosts only the link knows), sorted, capped, retired wolves skipped. */
export function createPackSummary(src: PackSummarySource): PackSummary {
  const now = src.now ?? Date.now;
  const ttl = src.ttlMs ?? 2_000;
  const since = new Map<string, string>();
  let labels: Map<string, string> | undefined;
  let cached: { at: number; hosts: HubHealthHost[] } | undefined;
  const build = (): HubHealthHost[] => {
    if (!labels) {
      try {
        labels = src.labels();
      } catch {
        labels = new Map();
      }
    }
    const byHost = new Map<string, string[]>();
    for (const h of src.hosts()) byHost.set(h.name, []);
    for (const w of src.wolves()) {
      if (!w.host || w.status === "retired") continue;
      if (!byHost.has(w.host)) byHost.set(w.host, []);
      byHost.get(w.host)!.push(w.name);
    }
    // Hosts only the link knows stay while linked; a host gone from the registry and offline leaves (and its `since` is pruned).
    for (const h of [...since.keys()]) {
      if (byHost.has(h)) continue;
      if (src.presence(h) === "offline") since.delete(h);
      else byHost.set(h, []);
    }
    return [...byHost.keys()].sort().slice(0, HUB_HEALTH_MAX_HOSTS).map((id) => {
      const presence = src.presence(id);
      const raw = labels!.get(id);
      const label = raw !== undefined && HOSTNAME_LABEL.test(raw) ? raw : undefined; // /healthz is unauthenticated: free-text labels (a person's name) are never sent
      const machine = normaliseMachine(src.machine?.(id)); // public /healthz: only a valid hostname label goes out
      const at = since.get(id);
      // /healthz is unauthenticated: list only the kinds the Machines section uses. key.set / key.remove are never listed here;
      // the Keys section learns key capability from its own authenticated route.
      const commands = [...(src.commands?.(id) ?? [])].filter((k) => PUBLIC_COMMANDS.has(k));
      const status = presence === "online" ? "online" : "offline";
      return { id, ...(label ? { label } : {}), ...(machine ? { machine } : {}), ...(commands.length ? { commands } : {}), presence, ...(at ? { since: at } : {}), wolves: byHost.get(id)!.sort().slice(0, HUB_HEALTH_MAX_WOLVES).map((name) => ({ name, status })) };
    });
  };
  return {
    hosts() {
      const t = now();
      if (!cached || t - cached.at >= ttl) {
        try {
          cached = { at: t, hosts: build() };
        } catch {
          return cached?.hosts ?? []; // a registry read failure must not take /healthz down
        }
      }
      return cached.hosts;
    },
    presenceChanged(hostId) {
      since.set(hostId, new Date(now()).toISOString());
      cached = undefined;
    },
    registryChanged() {
      cached = undefined;
    },
    labelsChanged() {
      labels = undefined;
      cached = undefined;
    },
  };
}
