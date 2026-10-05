/**
 * Backend resolution: pick Local or Remote based on --host / default host.
 *
 *   no host, no default  → LocalBackend  (wolves under ~/wolves/local/)
 *   host given / default  → RemoteBackend (that host's agent)
 */

import { loadConfig, getHost, type CliConfig } from "../config.js";
import { LocalBackend } from "./local.js";
import { RemoteBackend } from "./remote.js";
import type { WolfBackend } from "./types.js";

export * from "./types.js";
export { LocalBackend } from "./local.js";
export { RemoteBackend } from "./remote.js";

/**
 * Resolve a single backend for an explicit host (or local when none).
 * Throws if a named host is not registered.
 */
export function resolveBackend(host: string | undefined, config?: CliConfig): WolfBackend {
  const cfg = config ?? loadConfig();
  const hostName = host ?? cfg.defaultHost;

  // No host anywhere → operate locally
  if (!hostName || hostName === "local") {
    return new LocalBackend();
  }

  const entry = getHost(cfg, hostName);
  if (!entry) {
    throw new Error(`Host '${hostName}' not found. Run \`wolfpack host list\`.`);
  }
  return new RemoteBackend(hostName, entry);
}

/** Every backend: local + each registered host. Used by `list`. */
export function allBackends(config?: CliConfig): WolfBackend[] {
  const cfg = config ?? loadConfig();
  const backends: WolfBackend[] = [new LocalBackend()];
  for (const [name, entry] of Object.entries(cfg.hosts)) {
    backends.push(new RemoteBackend(name, entry));
  }
  return backends;
}
