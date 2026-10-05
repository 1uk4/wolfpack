/**
 * CLI configuration — reads from ~/.wolfpack/config.yaml
 *
 * Stores host connections, API keys, and preferences.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

export interface HostEntry {
  /** Tailscale or public IP */
  address: string;
  /** Agent port (default 3141) */
  port: number;
  /** API key for this host's agent */
  apiKey: string;
  /** SSH configuration */
  ssh: {
    user: string;
    key: string;
    port: number;
  };
}

export interface CliConfig {
  /** Default host for remote operations */
  defaultHost?: string;
  /**
   * Root of the host-first wolves tree: <root>/<host>/<wolf>/.
   *   <root>/local/<wolf>   — wolves running on this machine (authoritative)
   *   <root>/<vpshost>/<wolf> — read-only backup mirror of a VPS wolf's den
   *   <root>/shared/        — cross-wolf shared memory (librarian; added later)
   */
  wolvesRoot: string;
  /** Registered hosts */
  hosts: Record<string, HostEntry>;
}

/** Namespace for wolves that run on this machine. */
export const LOCAL_HOST = "local";

const CONFIG_DIR = path.join(os.homedir(), ".wolfpack");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml");

const DEFAULT_CONFIG: CliConfig = {
  wolvesRoot: path.join(os.homedir(), "wolves"),
  hosts: {},
};

export function loadConfig(): CliConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = yamlParse(raw) as Partial<CliConfig> & { wolfsDir?: string };
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      // Back-compat: old configs used `wolfsDir`
      wolvesRoot: parsed.wolvesRoot ?? parsed.wolfsDir ?? DEFAULT_CONFIG.wolvesRoot,
      hosts: { ...DEFAULT_CONFIG.hosts, ...parsed.hosts },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Absolute path to a wolf's directory: <root>/<host>/<wolf>/ */
export function wolfDir(config: CliConfig, host: string, name: string): string {
  return path.join(config.wolvesRoot, host, name);
}

/** Absolute path to a local wolf: <root>/local/<wolf>/ */
export function localWolfDir(config: CliConfig, name: string): string {
  return wolfDir(config, LOCAL_HOST, name);
}

/** Directory holding local wolves: <root>/local/ */
export function localHostDir(config: CliConfig): string {
  return path.join(config.wolvesRoot, LOCAL_HOST);
}

/** Shared cross-wolf memory root: <root>/shared/ (librarian lives here later). */
export function sharedDir(config: CliConfig): string {
  return path.join(config.wolvesRoot, "shared");
}

export function saveConfig(config: CliConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, yamlStringify(config));
}

export function getHost(config: CliConfig, name?: string): HostEntry | undefined {
  const hostName = name ?? config.defaultHost;
  if (!hostName) return undefined;
  return config.hosts[hostName];
}
