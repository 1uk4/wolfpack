/**
 * Wolf lifecycle management — create, start, stop, configure wolves on this host.
 *
 * Each wolf gets:
 *   - Unix user: wolf-<id>
 *   - Home dir:  /home/wolf-<id>/
 *   - Systemd:   wolf-<id>.service
 *   - Tmux:      session named after wolf id
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import type {
  WolfConfig,
  WolfStatus,
  CreateWolfRequest,
  UpdateWolfConfigRequest,
} from "./types.js";

const exec = promisify(execFile);

/** Generate a 6-char wolf ID */
function generateId(): string {
  return nanoid(6);
}

/** Unix username for a wolf */
function wolfUser(id: string): string {
  return `wolf-${id}`;
}

/** Home directory for a wolf */
function wolfHome(id: string): string {
  return `/home/${wolfUser(id)}`;
}

/** Systemd service name */
function wolfService(id: string): string {
  return `wolf-${id}.service`;
}

export class WolfManager {
  private wolvesIndex: Map<string, WolfConfig> = new Map();
  private indexPath: string;

  constructor(private agentDataDir: string = "/opt/wolfpack") {
    this.indexPath = path.join(agentDataDir, "wolves.json");
  }

  /** Load wolf index from disk */
  async init(): Promise<void> {
    await fs.mkdir(this.agentDataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const entries: WolfConfig[] = JSON.parse(raw);
      for (const w of entries) {
        this.wolvesIndex.set(w.id, w);
      }
    } catch {
      // No index yet — that's fine
    }
  }

  /** Persist wolf index to disk */
  private async saveIndex(): Promise<void> {
    const entries = Array.from(this.wolvesIndex.values());
    await fs.writeFile(this.indexPath, JSON.stringify(entries, null, 2));
  }

  /** Resolve a name or ID to a wolf config */
  resolve(nameOrId: string): WolfConfig | undefined {
    // Try ID first
    const byId = this.wolvesIndex.get(nameOrId);
    if (byId) return byId;

    // Try name
    for (const w of this.wolvesIndex.values()) {
      if (w.name === nameOrId) return w;
    }
    return undefined;
  }

  /** List all wolves on this host */
  list(): WolfConfig[] {
    return Array.from(this.wolvesIndex.values());
  }

  /** Create a new wolf */
  async create(req: CreateWolfRequest): Promise<WolfConfig> {
    const id = generateId();
    const user = wolfUser(id);
    const home = wolfHome(id);

    // 1. Create unix user
    await exec("sudo", ["useradd", "-m", "-s", "/bin/bash", user]);

    // 2. Create directory structure
    const dirs = ["den", "den/memory", "den/tasks", "logs"];
    for (const dir of dirs) {
      await fs.mkdir(path.join(home, dir), { recursive: true });
    }

    // 3. Build wolf config
    const config: WolfConfig = {
      id,
      name: req.name,
      runtime: req.runtime,
      model: req.model,
      role: req.role,
      specialty: req.specialty,
      domains: req.domains,
      telegram: req.telegram,
      extensions: req.extensions,
    };

    // 4. Write wolf.yaml
    await fs.writeFile(
      path.join(home, "wolf.yaml"),
      yamlStringify(config),
    );

    // 5. Write .env
    const envLines: string[] = [`WOLF_ID=${id}`, `WOLF_NAME=${req.name}`];
    if (req.env) {
      for (const [k, v] of Object.entries(req.env)) {
        envLines.push(`${k}=${v}`);
      }
    }
    await fs.writeFile(path.join(home, ".env"), envLines.join("\n") + "\n", {
      mode: 0o600,
    });

    // 6. Fix ownership
    await exec("sudo", ["chown", "-R", `${user}:${user}`, home]);

    // 7. Create systemd service
    await this.installService(config);

    // 8. Register in index
    this.wolvesIndex.set(id, config);
    await this.saveIndex();

    // 9. Start the wolf
    await this.start(id);

    return config;
  }

  /** Install systemd service for a wolf */
  private async installService(config: WolfConfig): Promise<void> {
    const id = config.id;
    const user = wolfUser(id);
    const home = wolfHome(id);

    // For now, Pi runtime only
    const execStart = this.buildExecStart(config);

    const unit = `[Unit]
Description=Wolfpack Wolf: ${config.name} (${id})
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${home}
EnvironmentFile=${home}/.env
ExecStart=${execStart}
Restart=always
RestartSec=10
StandardOutput=append:${home}/logs/wolf.log
StandardError=append:${home}/logs/wolf.error.log

[Install]
WantedBy=multi-user.target
`;

    const servicePath = `/etc/systemd/system/${wolfService(id)}`;
    await fs.writeFile(servicePath, unit);
    await exec("sudo", ["systemctl", "daemon-reload"]);
    await exec("sudo", ["systemctl", "enable", wolfService(id)]);
  }

  /** Build the ExecStart command based on runtime */
  private buildExecStart(config: WolfConfig): string {
    const home = wolfHome(config.id);

    switch (config.runtime) {
      case "pi":
        // Pi runs in a tmux session
        return `/usr/bin/tmux new-session -d -s wolf-${config.id} 'cd ${home} && pi'`;
      case "claude":
        return `/usr/bin/tmux new-session -d -s wolf-${config.id} 'cd ${home} && claude'`;
      case "custom":
        return `/usr/bin/node ${home}/node_modules/.bin/wolf start`;
      default:
        return `/usr/bin/tmux new-session -d -s wolf-${config.id} 'cd ${home} && pi'`;
    }
  }

  /** Get status of a wolf */
  async status(id: string): Promise<WolfStatus> {
    const config = this.wolvesIndex.get(id);
    if (!config) throw new Error(`Wolf not found: ${id}`);

    try {
      const { stdout: activeOut } = await exec("systemctl", [
        "is-active",
        wolfService(id),
      ]);
      const serviceState = activeOut.trim();

      // Check tmux session
      let tmux = false;
      try {
        await exec("sudo", [
          "-u",
          wolfUser(id),
          "tmux",
          "has-session",
          "-t",
          `wolf-${id}`,
        ]);
        tmux = true;
      } catch {
        // No tmux session
      }

      // Get uptime
      let since: string | undefined;
      try {
        const { stdout: sinceOut } = await exec("systemctl", [
          "show",
          wolfService(id),
          "--property=ActiveEnterTimestamp",
          "--value",
        ]);
        since = sinceOut.trim() || undefined;
      } catch {
        // ignore
      }

      return {
        id,
        name: config.name,
        active: serviceState === "active",
        runtime: config.runtime,
        serviceState,
        tmux,
        since,
      };
    } catch {
      return {
        id,
        name: config.name,
        active: false,
        runtime: config.runtime,
        serviceState: "unknown",
        tmux: false,
        error: "Failed to probe status",
      };
    }
  }

  /** Start a wolf */
  async start(id: string): Promise<void> {
    await exec("sudo", ["systemctl", "start", wolfService(id)]);
  }

  /** Stop a wolf */
  async stop(id: string): Promise<void> {
    await exec("sudo", ["systemctl", "stop", wolfService(id)]);
  }

  /** Restart a wolf */
  async restart(id: string): Promise<void> {
    await exec("sudo", ["systemctl", "restart", wolfService(id)]);
  }

  /** Update wolf config */
  async updateConfig(
    id: string,
    updates: UpdateWolfConfigRequest,
  ): Promise<WolfConfig> {
    const config = this.wolvesIndex.get(id);
    if (!config) throw new Error(`Wolf not found: ${id}`);

    // Merge updates
    const updated: WolfConfig = {
      ...config,
      ...updates,
      // Don't allow overwriting id
      id: config.id,
    };

    // Write updated wolf.yaml
    const home = wolfHome(id);
    await fs.writeFile(path.join(home, "wolf.yaml"), yamlStringify(updated));

    // Update index
    this.wolvesIndex.set(id, updated);
    await this.saveIndex();

    // Restart to pick up changes
    await this.restart(id);

    return updated;
  }

  /** Remove a wolf entirely */
  async remove(id: string): Promise<void> {
    const user = wolfUser(id);

    // Stop service
    try {
      await exec("sudo", ["systemctl", "stop", wolfService(id)]);
      await exec("sudo", ["systemctl", "disable", wolfService(id)]);
    } catch {
      // May not exist
    }

    // Remove service file
    try {
      await fs.unlink(`/etc/systemd/system/${wolfService(id)}`);
      await exec("sudo", ["systemctl", "daemon-reload"]);
    } catch {
      // May not exist
    }

    // Remove user and home
    try {
      await exec("sudo", ["userdel", "-r", user]);
    } catch {
      // May not exist
    }

    // Remove from index
    this.wolvesIndex.delete(id);
    await this.saveIndex();
  }
}
