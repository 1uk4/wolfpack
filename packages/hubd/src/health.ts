import { baseHealth, createLagMonitor, type LagMonitor } from "@wolfpack/protocol/health-lag";
import type { HealthBody } from "@wolfpack/protocol";
import { hubVersion } from "./settings.js";

/**
 * GET /healthz for hubd. Unauthenticated on purpose: it leaks only liveness numbers and the package version, and a probe must
 * work with no token. Touches no KB or disk: the lag monitor is a rolling in-memory window, the version is read once and cached.
 */
export interface HubHealth {
  body(): HealthBody;
  stop(): void;
}

export function createHubHealth(): HubHealth {
  const monitor: LagMonitor = createLagMonitor();
  return { body: () => baseHealth("hubd", monitor, hubVersion()), stop: () => monitor.stop() };
}
