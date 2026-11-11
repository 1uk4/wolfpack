import { baseHealth, createLagMonitor, normaliseMachine, type LagMonitor } from "@wolfpack/protocol/health-lag";
import { HUB_HEALTH_MAX_HOSTS, HUB_HEALTH_MAX_WOLVES, type HealthBody, type HubHealthHost, type LinkPresence } from "@wolfpack/protocol";
import { hubVersion } from "./settings.js";

/**
 * GET /healthz for hubd. Unauthenticated on purpose: it leaks liveness numbers, the package version, and the pack summary
 * (`hosts`: host ids, pairing labels, wolf names and presence, which the console already shows elsewhere), and a probe must
 * work with no token. Touches no KB or disk per request: the lag monitor is a rolling in-memory window, the version is read
 * once and cached, and the summary is cached (see createPackSummary).
 */
export interface HubHealth {
  body(): HealthBody;
  stop(): void;
}

export function createHubHealth(hosts?: () => HubHealthHost[]): HubHealth {
  const monitor: LagMonitor = createLagMonitor();
  return { body: () => ({ ...baseHealth("hubd", monitor, hubVersion()), ...(hosts ? { hosts: hosts() } : {}) }), stop: () => monitor.stop() };
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
      const status = presence === "online" ? "online" : "offline";
      return { id, ...(label ? { label } : {}), ...(machine ? { machine } : {}), presence, ...(at ? { since: at } : {}), wolves: byHost.get(id)!.sort().slice(0, HUB_HEALTH_MAX_WOLVES).map((name) => ({ name, status })) };
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
