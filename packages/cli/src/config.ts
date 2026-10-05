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
}

export interface CliConfig {
  /** Default host for remote operations */
  defaultHost?: string;
  /** Local wolves directory */
  wolfsDir: string;
  /** Registered hosts */
  hosts: Record<string, HostEntry>;
}

const CONFIG_DIR = path.join(os.homedir(), ".wolfpack");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml");

const DEFAULT_CONFIG: CliConfig = {
  wolfsDir: path.join(os.homedir(), "wolves"),
  hosts: {},
};

export function loadConfig(): CliConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = yamlParse(raw) as Partial<CliConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      hosts: { ...DEFAULT_CONFIG.hosts, ...parsed.hosts },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
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
