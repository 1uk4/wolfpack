/**
 * Wolf lifecycle management — create, start, stop, configure wolves on this host.
 *
 * PI-only, headless. Each wolf gets:
 *   - Unix user: wolf-<id>  (isolation: own files, own secrets, own systemd)
 *   - Home dir:  /home/wolf-<id>/{agent,den,logs}
 *       agent/   PI identity (PI_CODING_AGENT_DIR) — unpacked from the CLI bundle
 *       den/     WOLF_DEN — memory + tasks (authoritative on the VPS)
 *   - Systemd:   wolf-<id>.service → launch.sh → `pi --mode rpc`
 *
 * The agent runs as root (it manages unix users + systemd units), so commands
 * here are issued directly without sudo.
 *
 * Identity is never authored here: the CLI builds a portable `agent/` bundle
 * (settings + persona + esbuild-bundled extensions) and ships it; this module
 * unpacks it and owns only the OS-level wiring (user, env, systemd).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { stringify as yamlStringify } from "yaml";
import type {
  WolfConfig,
  WolfStatus,
  CreateWolfRequest,
  UpdateWolfConfigRequest,
  BundleManifest,
} from "./types.js";

const exec = promisify(execFile);

/** Generate a 6-char wolf ID */
function generateId(): string {
  return nanoid(6);
}

function wolfUser(id: string): string {
  return `wolf-${id}`;
}

function wolfHome(id: string): string {
  return `/home/${wolfUser(id)}`;
}

function wolfService(id: string): string {
  return `wolf-${id}.service`;
}

export class WolfManager {
  private wolvesIndex: Map<string, WolfConfig> = new Map();
  private indexPath: string;

  constructor(private agentDataDir: string = "/opt/wolfpack") {
    this.indexPath = path.join(agentDataDir, "wolves.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.agentDataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const entries: WolfConfig[] = JSON.parse(raw);
      for (const w of entries) this.wolvesIndex.set(w.id, w);
    } catch {
      // No index yet — fine.
    }
  }

  private async saveIndex(): Promise<void> {
    const entries = Array.from(this.wolvesIndex.values());
    await fs.writeFile(this.indexPath, JSON.stringify(entries, null, 2));
  }

  resolve(nameOrId: string): WolfConfig | undefined {
    const byId = this.wolvesIndex.get(nameOrId);
    if (byId) return byId;
    for (const w of this.wolvesIndex.values()) {
      if (w.name === nameOrId) return w;
    }
    return undefined;
  }

  list(): WolfConfig[] {
    return Array.from(this.wolvesIndex.values());
  }

  /** Create a new wolf: user, layout, identity bundle, env, systemd, start. */
  async create(req: CreateWolfRequest): Promise<WolfConfig> {
    const id = generateId();
    const user = wolfUser(id);
    const home = wolfHome(id);

    // 1. Unix user (own home, own shell).
    await exec("useradd", ["-m", "-s", "/bin/bash", user]);

    // 2. Layout.
    for (const dir of ["den", "den/memory", "den/tasks", "logs", "agent"]) {
      await fs.mkdir(path.join(home, dir), { recursive: true });
    }

    // 3. Identity: unpack the CLI-built bundle into agent/.
    if (req.bundle) {
      await this.extractBundle(home, req.bundle, { clean: true });
    }

    // 4. Config record (includes the bundle manifest for drift detection).
    const config: WolfConfig = {
      id,
      name: req.name,
      runtime: "pi",
      profile: req.profile,
      model: req.model,
      role: req.role,
      specialty: req.specialty,
      domains: req.domains,
      telegram: req.telegram,
      extensions: req.extensions,
      bundle: req.bundleManifest,
    };
    await fs.writeFile(path.join(home, "wolf.yaml"), yamlStringify(config));

    // 5. Env (secrets + runtime vars). WOLF_DEN/model drive the launcher + pi.
    await this.writeEnv(home, id, req);

    // 6. Launcher + systemd unit.
    await this.writeLauncher(home, id);
    await this.installService(config);

    // 7. Ownership (everything the wolf owns).
    await exec("chown", ["-R", `${user}:${user}`, home]);

    // 8. Register + start.
    this.wolvesIndex.set(id, config);
    await this.saveIndex();
    await this.start(id);

    return config;
  }

  /** Write /home/wolf-<id>/.env (mode 600). Standard vars + request env. */
  private async writeEnv(
    home: string,
    id: string,
    req: CreateWolfRequest,
  ): Promise<void> {
    const lines: string[] = [
      `WOLF_ID=${id}`,
      `WOLF_NAME=${req.name}`,
      `WOLF_DEN=${path.join(home, "den")}`,
      `WOLF_MODEL=${req.model}`,
    ];
    for (const [k, v] of Object.entries(req.env ?? {})) {
      lines.push(`${k}=${v}`);
    }
    await fs.writeFile(path.join(home, ".env"), lines.join("\n") + "\n", {
      mode: 0o600,
    });
  }

  /**
   * Write the per-wolf launcher. Runs `pi --mode rpc` with a held-open FIFO as
   * stdin so systemd's null stdin can't EOF-shut-down pi. The same FIFO is the
   * future injection point for the (deferred) agent→wolf RPC bridge.
   */
  private async writeLauncher(home: string, id: string): Promise<void> {
    const script = `#!/usr/bin/env bash
# wolf-${id} launcher — headless pi (RPC mode) with a persistent stdin FIFO.
set -u

RUNTIME="${home}/.run"
mkdir -p "$RUNTIME"
FIFO="$RUNTIME/rpc.in"
[ -p "$FIFO" ] || mkfifo "$FIFO"

# Hold the FIFO's write end open so pi never sees stdin EOF (= orderly shutdown).
# Later the Option-3 bridge writes JSONL commands into this FIFO.
sleep infinity > "$FIFO" &
KEEPALIVE=$!
trap 'kill "$KEEPALIVE" 2>/dev/null' EXIT INT TERM

MODEL_ARG=()
[ -n "\${WOLF_MODEL:-}" ] && MODEL_ARG=(--model "$WOLF_MODEL")

exec pi --mode rpc "\${MODEL_ARG[@]}" < "$FIFO"
`;
    const launchPath = path.join(home, "agent", "launch.sh");
    await fs.writeFile(launchPath, script, { mode: 0o755 });
  }

  /** Install/refresh the per-wolf systemd unit. */
  private async installService(config: WolfConfig): Promise<void> {
    const id = config.id;
    const user = wolfUser(id);
    const home = wolfHome(id);

    const unit = `[Unit]
Description=Wolfpack Wolf: ${config.name} (${id})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${home}/den
EnvironmentFile=${home}/.env
Environment=HOME=${home}
Environment=PI_CODING_AGENT_DIR=${home}/agent
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=${home}/agent/launch.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
    await fs.writeFile(`/etc/systemd/system/${wolfService(id)}`, unit);
    await exec("systemctl", ["daemon-reload"]);
    await exec("systemctl", ["enable", wolfService(id)]);
  }

  /**
   * Extract a base64 tar.gz identity bundle into <home>/agent/, preserving
   * runtime state (sessions, auth.json, trust.json, models-store.json).
   * With `clean`, the bundled `extensions/` dir is removed first so dropped
   * extensions don't linger.
   */
  private async extractBundle(
    home: string,
    bundleB64: string,
    opts: { clean?: boolean } = {},
  ): Promise<void> {
    const agentDir = path.join(home, "agent");
    await fs.mkdir(agentDir, { recursive: true });

    if (opts.clean) {
      await fs.rm(path.join(agentDir, "extensions"), {
        recursive: true,
        force: true,
      });
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wolf-unpack-"));
    const tarPath = path.join(tmp, "bundle.tgz");
    try {
      await fs.writeFile(tarPath, Buffer.from(bundleB64, "base64"));
      // Merges into agent/: overwrites settings/bundle/AGENTS/extensions,
      // leaves sessions/auth/trust untouched.
      await exec("tar", ["-xzf", tarPath, "-C", agentDir]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Replace a wolf's identity bundle in place and restart it (propagation).
   * Den + sessions are preserved.
   */
  async updateBundle(
    id: string,
    bundleB64: string,
    manifest: BundleManifest,
  ): Promise<WolfConfig> {
    const config = this.wolvesIndex.get(id);
    if (!config) throw new Error(`Wolf not found: ${id}`);
    const home = wolfHome(id);
    const user = wolfUser(id);

    await this.extractBundle(home, bundleB64, { clean: true });
    await exec("chown", ["-R", `${user}:${user}`, path.join(home, "agent")]);

    config.bundle = manifest;
    await fs.writeFile(path.join(home, "wolf.yaml"), yamlStringify(config));
    this.wolvesIndex.set(id, config);
    await this.saveIndex();

    await this.restart(id);
    return config;
  }

  async status(id: string): Promise<WolfStatus> {
    const config = this.wolvesIndex.get(id);
    if (!config) throw new Error(`Wolf not found: ${id}`);

    try {
      const { stdout: activeOut } = await exec("systemctl", [
        "is-active",
        wolfService(id),
      ]).catch((e) => ({ stdout: e.stdout ?? "unknown" }) as { stdout: string });
      const serviceState = activeOut.trim();

      let since: string | undefined;
      try {
        const { stdout } = await exec("systemctl", [
          "show",
          wolfService(id),
          "--property=ActiveEnterTimestamp",
          "--value",
        ]);
        since = stdout.trim() || undefined;
      } catch {
        // ignore
      }

      return {
        id,
        name: config.name,
        active: serviceState === "active",
        runtime: "pi",
        profile: config.profile,
        serviceState,
        since,
        bundle: config.bundle,
      };
    } catch {
      return {
        id,
        name: config.name,
        active: false,
        runtime: "pi",
        profile: config.profile,
        serviceState: "unknown",
        bundle: config.bundle,
        error: "Failed to probe status",
      };
    }
  }

  async start(id: string): Promise<void> {
    await exec("systemctl", ["start", wolfService(id)]);
  }

  async stop(id: string): Promise<void> {
    await exec("systemctl", ["stop", wolfService(id)]);
  }

  async restart(id: string): Promise<void> {
    await exec("systemctl", ["restart", wolfService(id)]);
  }

  /** Update wolf config (metadata only; identity changes go through updateBundle). */
  async updateConfig(
    id: string,
    updates: UpdateWolfConfigRequest,
  ): Promise<WolfConfig> {
    const config = this.wolvesIndex.get(id);
    if (!config) throw new Error(`Wolf not found: ${id}`);

    const updated: WolfConfig = { ...config, ...updates, id: config.id, runtime: "pi" };
    const home = wolfHome(id);
    await fs.writeFile(path.join(home, "wolf.yaml"), yamlStringify(updated));
    this.wolvesIndex.set(id, updated);
    await this.saveIndex();
    await this.restart(id);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const user = wolfUser(id);
    try {
      await exec("systemctl", ["stop", wolfService(id)]);
      await exec("systemctl", ["disable", wolfService(id)]);
    } catch {
      // may not exist
    }
    try {
      await fs.unlink(`/etc/systemd/system/${wolfService(id)}`);
      await exec("systemctl", ["daemon-reload"]);
    } catch {
      // may not exist
    }
    try {
      await exec("userdel", ["-r", user]);
    } catch {
      // may not exist
    }
    this.wolvesIndex.delete(id);
    await this.saveIndex();
  }
}
