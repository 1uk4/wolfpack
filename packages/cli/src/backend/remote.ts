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
    return (result.wolves ?? []).map((w) => {
      const raw = w as Record<string, unknown>;
      const bundle = raw.bundle as
        | { extensions?: Array<{ key: string; hash: string }>; modelTableHash?: string }
        | undefined;
      const bundleHashes: Record<string, string> = {};
      for (const e of bundle?.extensions ?? []) {
        bundleHashes[e.key] = e.hash;
      }
      return {
        id: w.id,
        name: w.name,
        host: this.host,
        runtime: w.runtime,
        profile: w.profile,
        domains: raw.domains as string[] | undefined,
        status: w.active ? "active" : w.serviceState,
        bundleHashes: Object.keys(bundleHashes).length ? bundleHashes : undefined,
        modelConfig: { transport: raw.transport, models: raw.models },
        modelTableHash: bundle?.modelTableHash,
      };
    });
  }

  async status(nameOrId: string): Promise<WolfStatusInfo> {
    const s = (await this.client.wolfStatus(nameOrId)) as Record<string, unknown>;
    const manifest = s.bundle as
      | {
          extensions?: Array<{ key: string; name: string; version: string; hash: string }>;
          modelTableHash?: string;
        }
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
      modelConfig: { transport: s.transport, models: s.models },
      modelTableHash: manifest?.modelTableHash,
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
