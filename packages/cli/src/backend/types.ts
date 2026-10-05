/**
 * WolfBackend — the management seam between the CLI and a wolf, regardless of
 * where it runs. Local wolves (this machine) and remote wolves (a VPS, via the
 * agent) implement the same contract so every command is location-agnostic.
 *
 * Scope is management only (no `ask`/`interact`): conversation happens through
 * the wolf's own PI + Telegram, not the CLI.
 */

export interface WolfSummary {
  id: string;
  name: string;
  host: string;
  runtime: string;
  profile?: string;
  /** Live-ish state label for the list view */
  status: string;
}

/** Snapshot of the memory extension's status, read from den/status.json. */
export interface MemorySnapshot {
  enabled: boolean;
  observations: number;
  poolTokens: number;
  consolidateAt: number;
  totalCostUsd: number;
  /** epoch ms of last write */
  updatedAt: number;
}

export interface WolfStatusInfo {
  id: string;
  name: string;
  host: string;
  runtime: string;
  /** Process/service believed to be running */
  active: boolean;
  /** Backend-specific state label (systemd state, "external", "stopped", ...) */
  serviceState: string;
  since?: string;
  error?: string;
  /** Memory sidechannel, if available */
  memory?: MemorySnapshot;
}

export interface LogOptions {
  lines?: number;
}

export interface WolfBackend {
  /** Host label this backend manages ("local" or a host name). */
  readonly host: string;

  list(): Promise<WolfSummary[]>;
  status(nameOrId: string): Promise<WolfStatusInfo>;
  logs(nameOrId: string, opts: LogOptions): Promise<string[]>;
  /** Stream logs; resolves when the stream ends (Ctrl-C). Optional. */
  follow?(nameOrId: string, onLine: (line: string) => void, lines: number): Promise<void>;
  restart(nameOrId: string): Promise<void>;
  remove(nameOrId: string): Promise<void>;
}
