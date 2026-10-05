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
  /** Usage profile: worker (local) | assistant (24/7 VPS) */
  profile?: WolfProfile;
  model: string;
  role: string;
  specialty?: string;
  domains: string[];
  telegram?: TelegramConfig;
  extensions?: string[];
}

export type WolfProfile = "worker" | "assistant";

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
  profile?: WolfProfile;
  /** systemd service state */
  serviceState: string;
  /** tmux session alive */
  tmux: boolean;
  /** Uptime string from systemd */
  since?: string;
  /** Error message if probe failed */
  error?: string;
}

/** Health of a host-level service (Tailscale, Syncthing). */
export interface ServiceHealth {
  /** Service name, e.g. "tailscale" | "syncthing" */
  name: string;
  /** Overall healthy flag */
  ok: boolean;
  /** Short state label (Running, synced, inactive, unavailable, ...) */
  state: string;
  /** Human-readable detail line */
  detail: string;
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
  /** Tailscale + Syncthing health */
  services: ServiceHealth[];
}

/** Request to create a new wolf */
export interface CreateWolfRequest {
  name: string;
  runtime: WolfRuntime;
  profile?: WolfProfile;
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
  profile?: WolfProfile;
  model?: string;
  role?: string;
  specialty?: string;
  domains?: string[];
  extensions?: string[];
  telegram?: TelegramConfig;
}
