/**
 * Core types for the wolfpack agent.
 */

/** Wolf identity — ID is stable, name is cosmetic. */
export interface WolfIdentity {
  /** 6-char nanoid — stable, never changes */
  id: string;
  /** Cosmetic display name — can be renamed */
  name: string;
}

/** Wolf configuration stored in wolf.yaml */
export interface WolfConfig {
  id: string;
  name: string;
  runtime: WolfRuntime;
  model: string;
  role: string;
  specialty?: string;
  domains: string[];
  telegram?: TelegramConfig;
  extensions?: string[];
}

export type WolfRuntime = "pi" | "claude" | "custom";

export interface TelegramConfig {
  /** Env var name for the token (not the token itself) */
  tokenEnv: string;
  /** Telegram user ID of the owner */
  ownerId: number;
}

/** Runtime status of a wolf on this host */
export interface WolfStatus {
  id: string;
  name: string;
  active: boolean;
  runtime: WolfRuntime;
  /** systemd service state */
  serviceState: string;
  /** tmux session alive */
  tmux: boolean;
  /** Uptime string from systemd */
  since?: string;
  /** Error message if probe failed */
  error?: string;
}

/** Host-level health information */
export interface HostHealth {
  hostname: string;
  uptime: string;
  cpuPercent: number;
  memPercent: number;
  memUsed: number;
  memTotal: number;
  diskPercent: number;
  wolves: WolfStatus[];
}

/** Request to create a new wolf */
export interface CreateWolfRequest {
  name: string;
  runtime: WolfRuntime;
  model: string;
  role: string;
  specialty?: string;
  domains: string[];
  telegram?: TelegramConfig;
  extensions?: string[];
  env?: Record<string, string>;
}

/** Request to update wolf config */
export interface UpdateWolfConfigRequest {
  name?: string;
  model?: string;
  role?: string;
  specialty?: string;
  domains?: string[];
  extensions?: string[];
}
