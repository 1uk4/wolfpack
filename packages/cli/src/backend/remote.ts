/**
 * RemoteBackend — wolves on a VPS, managed through that host's agent.
 * Thin adapter over AgentClient into the WolfBackend contract.
 */

import { AgentClient } from "../agent-client.js";
import type { HostEntry } from "../config.js";
import type {
  WolfBackend,
  WolfSummary,
  WolfStatusInfo,
  LogOptions,
} from "./types.js";

export class RemoteBackend implements WolfBackend {
  private client: AgentClient;

  constructor(
    readonly host: string,
    hostEntry: HostEntry,
  ) {
    this.client = new AgentClient(hostEntry);
  }

  async list(): Promise<WolfSummary[]> {
    const result = (await this.client.listWolves()) as {
      wolves: Array<{
        id: string;
        name: string;
        runtime: string;
        profile?: string;
        active: boolean;
        serviceState: string;
      }>;
    };
    return (result.wolves ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      host: this.host,
      runtime: w.runtime,
      profile: w.profile,
      status: w.active ? "active" : w.serviceState,
    }));
  }

  async status(nameOrId: string): Promise<WolfStatusInfo> {
    const s = (await this.client.wolfStatus(nameOrId)) as Record<string, unknown>;
    const manifest = s.bundle as
      | { extensions?: Array<{ key: string; name: string; version: string; hash: string }> }
      | undefined;
    return {
      id: String(s.id),
      name: String(s.name),
      host: this.host,
      runtime: String(s.runtime),
      active: !!s.active,
      serviceState: String(s.serviceState ?? "unknown"),
      since: s.since as string | undefined,
      error: s.error as string | undefined,
      bundle: manifest?.extensions,
      domains: s.domains as string[] | undefined,
    };
  }

  async logs(nameOrId: string, opts: LogOptions): Promise<string[]> {
    const result = (await this.client.logs(nameOrId, opts.lines ?? 100)) as {
      lines: string[];
    };
    return result.lines ?? [];
  }

  async follow(
    nameOrId: string,
    onLine: (line: string) => void,
    lines: number,
  ): Promise<void> {
    await this.client.streamLogs(nameOrId, onLine, lines);
  }

  async restart(nameOrId: string): Promise<void> {
    await this.client.restartWolf(nameOrId);
  }

  async remove(nameOrId: string): Promise<void> {
    await this.client.removeWolf(nameOrId);
  }
}
