/**
 * Wolf lifecycle management — create, start, stop, configure wolves on this host.
 *
 * PI-only, headless. Each wolf gets:
 *   - Unix user: wolf-<id>  (isolation: own files, own secrets, own systemd)
 *   - Home dir:  <WOLFPACK_HOME_ROOT>/wolf-<id>/{agent,den,logs}  (see paths.ts)
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
import { kbBase, kbOps, wolfHome, wolfUser } from "./paths.js";
import { restoreDenExtensions, snapshotDenExtensions, writeDenExtensions } from "./den-extensions.js";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import type {
  WolfConfig,
  WolfStatus,
  WolfRuntime,
  CreateWolfRequest,
  UpdateWolfConfigRequest,
  BundleManifest,
} from "./types.js";

const exec = promisify(execFile);

/** Generate a 6-char wolf ID */
function generateId(): string {
  return nanoid(6);
}

function wolfService(id: string): string {
  return `wolf-${id}.service`;
}

/** agent/.pending: the last sync has not been confirmed healthy (see updatePiDurableBundle). */
const PENDING_MARKER = ".pending";

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

  /**
   * Ensure standard wolf environment variables are set in .env,
   * preserving existing secrets and other vars.
   */
  private async ensureEnvVars(
    home: string,
    id: string,
    name: string,
    extra: Record<string, string> = {},
  ): Promise<void> {
    const envPath = path.join(home, ".env");
    let existing: string[] = [];
    try {
      existing = (await fs.readFile(envPath, "utf8")).split("\n").filter(Boolean);
    } catch {
      // No .env file yet
    }

    // Managed keys that should be set/overridden
    const managed: Record<string, string> = {
      WOLF_ID: id,
      WOLF_NAME: name,
      WOLF_DEN: path.join(home, "den"),
      KB_BASE: kbBase(),
      KB_OPS: kbOps(),
      ...extra,
    };

    // Keep existing env vars that aren't managed
    const kept = existing.filter((line) => {
      const key = line.slice(0, line.indexOf("="));
      return key && !(key in managed);
    });

    // Write back: managed vars first, then preserved vars
    const lines = [
      ...Object.entries(managed).map(([k, v]) => `${k}=${v}`),
      ...kept,
    ];
    await fs.writeFile(envPath, lines.join("\n") + "\n", { mode: 0o600 });

    // Ensure shared KB directories are writable (follow symlinks with -L)
    for (const dir of [kbOps(), kbBase()]) {
      try {
        // Use find to follow symlinks and chmod each file
        await exec("find", ["-L", dir, "-exec", "chmod", "a+rwX", "{}", ";"]);
      } catch {
        // Directory might not exist yet
      }
    }
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
      runtime: req.runtime ?? "pi",
      profile: req.profile,
      role: req.role,
      specialty: req.specialty,
      domains: req.domains,
      telegram: req.telegram,
      extensions: req.extensions,
      bundle: req.bundleManifest,
    };
    await fs.writeFile(path.join(home, "wolf.yaml"), yamlStringify(config));

    // 5. Env (secrets + runtime vars). WOLF_DEN drives the launcher + pi.
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

  /** Write <wolf home>/.env (mode 600). Standard vars + request env. */
  private async writeEnv(
    home: string,
    id: string,
    req: CreateWolfRequest,
  ): Promise<void> {
    const lines: string[] = [
      `WOLF_ID=${id}`,
      `WOLF_NAME=${req.name}`,
      `WOLF_DEN=${path.join(home, "den")}`,
      // KB paths for the memory extension's emit/read (host-relative layout).
      `KB_OPS=${path.join(home, "librarian")}`,
      `KB_BASE=${path.join(home, "knowledge", "base")}`,
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
  private async writeLauncher(home: string, id: string, runtime: WolfRuntime = "pi"): Promise<void> {
    let script: string;
    
    if (runtime === "pi-durable") {
      script = `#!/usr/bin/env bash
# wolf-${id} launcher — pi-durable harness
set -eu
cd "${home}"
# Add agent/node_modules for external deps (grammy)
export NODE_PATH="${home}/agent/node_modules"
exec node "${home}/agent/harness.cjs"
`;
    } else {
      script = `#!/usr/bin/env bash
# wolf-${id} launcher — headless pi (RPC mode) with a persistent stdin FIFO.
set -u

RUNTIME="${home}/.run"
mkdir -p "$RUNTIME"
FIFO="$RUNTIME/rpc.in"
[ -p "$FIFO" ] || mkfifo "$FIFO"

sleep infinity > "$FIFO" &
KEEPALIVE=$!
trap 'kill "$KEEPALIVE" 2>/dev/null' EXIT INT TERM

exec pi --mode rpc < "$FIFO"
`;
    }
    
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

  /**
   * Update a pi-durable wolf's bundle with env management and cleanup.
   * Ensures env vars, disables old sweep timer, then updates bundle.
   */
  async updatePiDurableBundle(
    id: string,
    harnessB64: string,
    wolfYamlB64: string,
    agentsMdB64: string,
    extensionsMap?: Record<string, string>,
    modelsB64?: string,
    env?: Record<string, string>,
  ): Promise<WolfConfig> {
    const config = this.wolvesIndex.get(id);
    if (!config) throw new Error(`Wolf not found: ${id}`);
    const home = wolfHome(id);
    const user = wolfUser(id);
    const agentDir = path.join(home, "agent");
    const denDir = path.join(home, "den");

    // Ensure agent dir exists
    await fs.mkdir(agentDir, { recursive: true });

    // Keep what this sync replaces (harness, shipped extensions, wolf.yaml, models.json) so a sync that crash-loops can
    // be rolled back as a set (rollbackHarness). Not rotated while the previous sync was never confirmed healthy
    // (agent/.pending exists, cleared by confirmSync or a rollback): two bad syncs in a row must not overwrite the good set.
    const harnessPath = path.join(agentDir, "harness.cjs");
    const pending = path.join(agentDir, PENDING_MARKER);
    const unconfirmed = await fs.access(pending).then(() => true, () => false);
    const extBackup = path.join(agentDir, "extensions.prev");
    const cfgBackup = path.join(agentDir, "config.prev");
    if (unconfirmed) {
      console.warn(`[agent] ${id}: the previous sync was never confirmed healthy; keeping its rollback set (harness.prev.cjs, extensions.prev, config.prev)`);
    } else {
      await fs.copyFile(harnessPath, path.join(agentDir, "harness.prev.cjs")).catch(() => {});
      await fs.rm(cfgBackup, { recursive: true, force: true });
      await fs.mkdir(cfgBackup, { recursive: true });
      for (const f of ["wolf.yaml", "models.json"]) await fs.copyFile(path.join(home, f), path.join(cfgBackup, f)).catch(() => {});
      // Snapshot BEFORE anything is replaced: a non-ENOENT error here fails the sync with the wolf untouched.
      if (extensionsMap) await snapshotDenExtensions(denDir, extBackup, extensionsMap);
      else await fs.rm(extBackup, { recursive: true, force: true });
    }
    await fs.writeFile(pending, new Date().toISOString());
    await fs.writeFile(harnessPath, Buffer.from(harnessB64, "base64"));

    // Write shipped extensions to den/extensions/<name>/index.js. The den also
    // holds the owner's own extensions, so never wipe the directory: remove
    // only what an earlier sync shipped (recorded in .managed.json) and no
    // longer ships, and leave every other name alone.
    if (extensionsMap) await writeDenExtensions(denDir, extensionsMap);

    // Write AGENTS.md
    const agentsPath = path.join(agentDir, "AGENTS.md");
    await fs.writeFile(agentsPath, Buffer.from(agentsMdB64, "base64"));

    // Resolved model table (resolved by the CLI), next to wolf.yaml — the
    // harness refuses to start without it.
    if (modelsB64) {
      await fs.writeFile(path.join(home, "models.json"), Buffer.from(modelsB64, "base64"));
    }

    // Update wolf.yaml from bundle (contains updated config)
    const wolfYamlContent = Buffer.from(wolfYamlB64, "base64").toString("utf-8");
    const newConfig = yamlParse(wolfYamlContent) as WolfConfig;

    // Merge: keep existing fields, update from bundle. The removed model:/
    // provider: keys are dropped so they can't linger from an older config.
    const { model: _model, provider: _provider, ...kept } = config as WolfConfig & { model?: unknown; provider?: unknown };
    const merged: WolfConfig = { ...kept, ...newConfig, id: config.id, runtime: "pi-durable" };
    await fs.writeFile(path.join(home, "wolf.yaml"), yamlStringify(merged));
    this.wolvesIndex.set(id, merged);

    // Install grammy if telegram extension is used
    if (merged.extensions?.includes("telegram")) {
      const grammyCheck = path.join(agentDir, "node_modules", "grammy");
      try {
        await fs.access(grammyCheck);
      } catch {
        await exec("npm", ["install", "--prefix", agentDir, "grammy"], { cwd: home });
      }
    }

    // Ensure standard env vars are set, plus any secrets the sync ships
    await this.ensureEnvVars(home, id, config.name, syncedEnv(env));

    // Disable old sweep timer (silently ignore errors)
    try { await exec("systemctl", ["stop", `${user}-kb-sweep.timer`]).catch(() => {}); } catch {}
    try { await exec("systemctl", ["disable", `${user}-kb-sweep.timer`]).catch(() => {}); } catch {}
    try { await exec("systemctl", ["stop", `${user}-kb-sweep.service`]).catch(() => {}); } catch {}

    // Update launcher for pi-durable runtime
    await this.writeLauncher(home, id, "pi-durable");
    await this.saveIndex();

    // Fix ownership
    await exec("chown", ["-R", `${user}:${user}`, agentDir]);
    await exec("chown", ["-R", `${user}:${user}`, denDir]);
    if (modelsB64) await exec("chown", [`${user}:${user}`, path.join(home, "models.json")]);

    await this.restart(id);
    return merged;
  }

  /**
   * Put the previous harness bundle (harness.prev.cjs, kept by the last
   * updatePiDurableBundle) back and restart the wolf. Throws when there is none.
   */
  async rollbackHarness(id: string): Promise<void> {
    if (!this.wolvesIndex.has(id)) throw new Error(`Wolf not found: ${id}`);
    const agentDir = path.join(wolfHome(id), "agent");
    const prev = path.join(agentDir, "harness.prev.cjs");
    try {
      await fs.access(prev);
    } catch {
      throw new Error(`No previous harness bundle to roll back to for ${id}`);
    }
    await fs.copyFile(prev, path.join(agentDir, "harness.cjs"));
    const user = wolfUser(id);
    await exec("chown", [`${user}:${user}`, path.join(agentDir, "harness.cjs")]);
    // The extensions, wolf.yaml and models.json that shipped with the bad bundle go back too (a harness + extension
    // + config set must match). A missing snapshot is a partial rollback and says so.
    const home = wolfHome(id);
    const denDir = path.join(home, "den");
    if (await restoreDenExtensions(denDir, path.join(agentDir, "extensions.prev"))) {
      await exec("chown", ["-R", `${user}:${user}`, path.join(denDir, "extensions")]);
    } else {
      console.warn(`[agent] ${id}: rollback restored harness.cjs only: no extensions.prev snapshot, den extensions left as they are`);
    }
    for (const f of ["wolf.yaml", "models.json"]) {
      const saved = path.join(agentDir, "config.prev", f);
      if (await fs.access(saved).then(() => true, () => false)) {
        await fs.copyFile(saved, path.join(home, f));
        await exec("chown", [`${user}:${user}`, path.join(home, f)]);
        if (f === "wolf.yaml") this.wolvesIndex.set(id, yamlParse(await fs.readFile(saved, "utf-8")) as WolfConfig);
      } else {
        console.warn(`[agent] ${id}: rollback has no saved ${f}; left as it is`);
      }
    }
    // The restored set is the known-good one.
    await fs.rm(path.join(agentDir, PENDING_MARKER), { force: true });
    await this.saveIndex();
    await this.restart(id);
  }

  /** The wolf came back healthy after the last sync: it may now rotate the rollback set on the next one. */
  async confirmSync(id: string): Promise<void> {
    if (!this.wolvesIndex.has(id)) throw new Error(`Wolf not found: ${id}`);
    await fs.rm(path.join(wolfHome(id), "agent", PENDING_MARKER), { force: true });
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

      // Automatic restarts so far: a crash-looping wolf keeps counting up.
      let restarts: number | undefined;
      try {
        const { stdout } = await exec("systemctl", ["show", wolfService(id), "--property=NRestarts", "--value"]);
        const n = Number(stdout.trim());
        restarts = Number.isFinite(n) && stdout.trim() !== "" ? n : undefined;
      } catch {
        // ignore
      }

      return {
        id,
        name: config.name,
        active: serviceState === "active",
        restarts,
        runtime: config.runtime ?? "pi",
        profile: config.profile,
        serviceState,
        since,
        bundle: config.bundle,
        domains: config.domains,
        transport: config.transport,
        models: config.models,
      };
    } catch {
      return {
        id,
        name: config.name,
        active: false,
        runtime: config.runtime ?? "pi",
        profile: config.profile,
        serviceState: "unknown",
        bundle: config.bundle,
        domains: config.domains,
        transport: config.transport,
        models: config.models,
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

    // Deep-merge nested objects (memory, telegram, harness, models) instead of
    // replacing. A null value clears: the key is deleted (top level or one
    // level down, e.g. `models: { fast: null }`), and a nested object left
    // empty is dropped, so wolf.yaml never carries `null`.
    const runtime = ((updates as Record<string, unknown>).runtime ?? config.runtime ?? "pi") as WolfConfig["runtime"];
    const merged: Record<string, unknown> = { ...config as unknown as Record<string, unknown> };
    for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
      if (value === null) {
        delete merged[key];
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        const base = merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])
          ? (merged[key] as Record<string, unknown>)
          : {};
        const next: Record<string, unknown> = { ...base, ...(value as Record<string, unknown>) };
        for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
        if (Object.keys(next).length > 0) merged[key] = next;
        else delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    const updated = { ...merged, id: config.id, runtime } as WolfConfig;
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

/** Env keys a sync may set in a wolf's .env (secrets the CLI ships). */
const SYNCED_ENV_KEYS = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

function syncedEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (SYNCED_ENV_KEYS.has(k) && typeof v === "string" && v && !/[\r\n]/.test(v)) out[k] = v;
  }
  return out;
}

