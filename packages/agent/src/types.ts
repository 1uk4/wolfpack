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
  /** Manifest of the last identity bundle applied (versions + hashes). */
  bundle?: BundleManifest;
}

export type WolfProfile = "worker" | "assistant";

/** Wolfpack is PI-only. Kept as a type for forward-compat, single value today. */
export type WolfRuntime = "pi";

/** Version + content identity of one installed extension (drift detection). */
export interface ExtensionStamp {
  key: string;
  name: string;
  version: string;
  hash: string;
}

/** Manifest of the identity bundle a wolf was last provisioned/synced with. */
export interface BundleManifest {
  builtAt: string;
  extensions: ExtensionStamp[];
}

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
  /** Uptime string from systemd */
  since?: string;
  /** Manifest of the installed identity bundle (versions + hashes). */
  bundle?: BundleManifest;
  /** KB domains this wolf subscribes to (from wolf.yaml). */
  domains?: string[];
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
  /** base64(gzip(tar)) of the PI identity `agent/` dir, built by the CLI. */
  bundle?: string;
  /** Manifest describing the bundle (versions + hashes). */
  bundleManifest?: BundleManifest;
}

/** Request to replace a wolf's identity bundle in place (propagate updates). */
export interface UpdateBundleRequest {
  /** base64(gzip(tar)) of the new PI identity `agent/` dir. */
  bundle: string;
  /** Manifest describing the new bundle. */
  manifest: BundleManifest;
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
