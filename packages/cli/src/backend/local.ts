/**
 * LocalBackend — wolves living on this machine under <root>/local/<wolf>/.
 *
 * Local wolves are authoritative here but their PI process is user-driven
 * (e.g. via Herdr), not daemon-managed by wolfpack. So `restart` is not a
 * wolfpack operation locally; `status` is derived from the memory sidechannel
 * (den/status.json) plus an optional tmux probe.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as yamlParse } from "yaml";
import { loadConfig, localHostDir, localWolfDir, LOCAL_HOST } from "../config.js";
import type {
  WolfBackend,
  WolfSummary,
  WolfStatusInfo,
  LogOptions,
  MemorySnapshot,
} from "./types.js";

const exec = promisify(execFile);

interface LocalWolf {
  dir: string;
  id: string;
  name: string;
  runtime: string;
  profile?: string;
}

/** Freshness window: a status.json newer than this is considered "live". */
const LIVE_WINDOW_MS = 2 * 60 * 1000;

export class LocalBackend implements WolfBackend {
  readonly host = LOCAL_HOST;

  private root(): string {
    return localHostDir(loadConfig());
  }

  private readWolf(dir: string): LocalWolf | null {
    const yamlPath = path.join(dir, "wolf.yaml");
    if (!fs.existsSync(yamlPath)) return null;
    try {
      const w = yamlParse(fs.readFileSync(yamlPath, "utf8")) as {
        id: string;
        name: string;
        runtime: string;
        profile?: string;
      };
      return { dir, id: w.id, name: w.name, runtime: w.runtime, profile: w.profile };
    } catch {
      return null;
    }
  }

  private resolve(nameOrId: string): LocalWolf {
    // Fast path: directory named after the wolf
    const direct = this.readWolf(localWolfDir(loadConfig(), nameOrId));
    if (direct) return direct;

    const root = this.root();
    if (fs.existsSync(root)) {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const w = this.readWolf(path.join(root, d.name));
        if (w && (w.id === nameOrId || w.name === nameOrId)) return w;
      }
    }
    throw new Error(`Local wolf not found: ${nameOrId}`);
  }

  private readMemory(dir: string): MemorySnapshot | undefined {
    const p = path.join(dir, "den", "status.json");
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as MemorySnapshot;
      return raw;
    } catch {
      return undefined;
    }
  }

  /** Is a tmux session named wolf-<id> alive? (best-effort) */
  private async tmuxAlive(id: string): Promise<boolean> {
    try {
      await exec("tmux", ["has-session", "-t", `wolf-${id}`], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<WolfSummary[]> {
    const root = this.root();
    if (!fs.existsSync(root)) return [];
    const out: WolfSummary[] = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const w = this.readWolf(path.join(root, d.name));
      if (!w) continue;
      const mem = this.readMemory(w.dir);
      const live = mem && Date.now() - mem.updatedAt < LIVE_WINDOW_MS;
      out.push({
        id: w.id,
        name: w.name,
        host: LOCAL_HOST,
        runtime: w.runtime,
        profile: w.profile,
        status: live ? "live" : "—",
      });
    }
    return out;
  }

  async status(nameOrId: string): Promise<WolfStatusInfo> {
    const w = this.resolve(nameOrId);
    const mem = this.readMemory(w.dir);
    const tmux = await this.tmuxAlive(w.id);
    const live = !!mem && Date.now() - mem.updatedAt < LIVE_WINDOW_MS;
    const active = tmux || live;
    return {
      id: w.id,
      name: w.name,
      host: LOCAL_HOST,
      runtime: w.runtime,
      active,
      serviceState: tmux ? "tmux" : live ? "live" : "external",
      memory: mem,
    };
  }

  async logs(nameOrId: string, opts: LogOptions): Promise<string[]> {
    const w = this.resolve(nameOrId);
    const logPath = path.join(w.dir, "logs", "wolf.log");
    if (!fs.existsSync(logPath)) return [];
    const content = fs.readFileSync(logPath, "utf8").split("\n");
    const n = opts.lines ?? 100;
    return content.slice(-n);
  }

  async restart(_nameOrId: string): Promise<void> {
    throw new Error(
      "Local wolves run in your terminal (e.g. Herdr) and are not restarted by wolfpack. " +
        "Restart the PI session there.",
    );
  }

  async remove(nameOrId: string): Promise<void> {
    const w = this.resolve(nameOrId);
    fs.rmSync(w.dir, { recursive: true, force: true });
  }
}
