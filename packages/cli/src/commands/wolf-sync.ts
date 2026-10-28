/**
 * wolfpack sync <wolf> [--host <h>] [--all]
 *
 * Propagate extension/identity updates to already-provisioned wolves. Rebuilds
 * the portable identity bundle from the current repo `extensions/` + the wolf's
 * stored config, ships it to the host agent, which swaps `agent/` in place
 * (preserving den + sessions) and restarts the wolf.
 *
 * Local wolves load extensions from the repo directly, so they are always
 * current — `sync` is a no-op for them (reported as such).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import { AgentClient } from "../agent-client.js";
import { smokeCheckBundle, smokeStartBundle, watchAfterRestart } from "../sync-safety.js";
import { buildRemoteBundle, buildHarnessBundle, stampExtension } from "../bundle.js";
import {
  loadConfig,
  getHost,
  localWolfDir,
  wolfDir,
  kbBaseDir,
  librarianDir,
  type CliConfig,
  type HostEntry,
} from "../config.js";
import { isLibrarian, isLibrarianConfig, writePiSettings } from "../extensions.js";
import { provisionKbEngine } from "../deployer.js";
import { deployDomainsRegistry } from "../librarian-registry.js";
import { reconcileMesh } from "../mesh-reconcile.js";
import { c } from "../render.js";
import { resolveLocalWolfModels, resolveRemoteWolfModels } from "../models.js";
import { readEnvValue } from "./wolf-models.js";
import { ingestUsageQuietly } from "./usage.js";
import { ModelConfigError, piModelArg, type ModelTable } from "@wolfpack/engine";

interface SyncOpts {
  host?: string;
  all?: boolean;
}

/** Shape the agent returns from GET /wolves/:id (status + embedded config). */
interface RemoteWolf {
  id: string;
  name: string;
  config?: {
    name: string;
    role: string;
    specialty?: string;
    domains?: string[];
    extensions?: string[];
    telegram?: { ownerId?: number };
    transport?: string;
    models?: unknown;
  };
}

export async function wolfSync(
  name: string | undefined,
  opts: SyncOpts,
): Promise<void> {
  const config = loadConfig();

  // Capture usage into the ledger before anything is rebuilt or restarted.
  await ingestUsageQuietly();

  if (opts.all) {
    await syncAll(config);
    return;
  }

  if (!name) {
    console.error(c.red("Usage: wolfpack sync <wolf> [--host <h>] | --all"));
    process.exit(1);
  }

  // A local wolf (no --host) reconciles from config even when a default remote
  // host is set — otherwise it'd be mistaken for a remote wolf.
  const localExists = fs.existsSync(path.join(localWolfDir(config, name), "wolf.yaml"));
  if (!opts.host && localExists) {
    syncLocal(config, name);
  } else {
    const host = getHost(config, opts.host);
    if (!host) {
      console.error(c.red(`'${name}' not found locally and no host specified.`));
      process.exit(1);
    }

    const hostName = opts.host ?? config.defaultHost!;
    await syncOne(config, host, hostName, name);
  }

  await runMeshReconcile();
}

/**
 * Reconcile a LOCAL wolf from its wolf.yaml: regenerate the managed .env keys
 * (WOLF_*, KB_BASE, KB_OPS) preserving any secrets already present, and rewrite
 * .pi/settings.json from the declared extensions. Local wolves ride the Mac hub
 * for KB, so there is no per-wolf Syncthing to wire here.
 */
function syncLocal(config: CliConfig, name: string): void {
  const dir = localWolfDir(config, name);
  const yamlPath = path.join(dir, "wolf.yaml");
  if (!fs.existsSync(yamlPath)) {
    console.error(c.red(`Local wolf not found: ${name}`));
    process.exit(1);
  }
  const wolf = yamlParse(fs.readFileSync(yamlPath, "utf8")) as {
    id: string; name: string; extensions?: string[];
  };

  // Managed env keys (regenerated from config); everything else is preserved.
  const managed: Record<string, string> = {
    WOLF_ID: wolf.id,
    WOLF_NAME: wolf.name,
    WOLF_DEN: path.join(dir, "den"),
    KB_BASE: kbBaseDir(config),
    KB_OPS: librarianDir(config),
  };
  const envPath = path.join(dir, ".env");
  const existing: string[] = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8").split("\n").filter(Boolean)
    : [];
  const kept = existing.filter((l) => {
    const k = l.slice(0, l.indexOf("="));
    return k && !(k in managed);
  });
  const lines = [...Object.entries(managed).map(([k, v]) => `${k}=${v}`), ...kept];
  fs.writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });

  // pi's default model follows the resolved main tier (launch also passes
  // --model; this covers pi started without `wolfpack launch`).
  const table = resolveModelsOrExit(() => resolveLocalWolfModels(config, name));
  const missing = writePiSettings(dir, wolf.extensions ?? [], table.tiers.main);
  console.log(c.green(`\u2713 Reconciled local wolf ${wolf.name} from config`));
  console.log(c.dim(`  .env:    ${Object.keys(managed).join(", ")} (+${kept.length} preserved)`));
  console.log(c.dim(`  Exts:    ${wolf.extensions?.length ? wolf.extensions.join(", ") : "(none)"}`));
  console.log(c.dim(`  Model:   ${piModelArg(table.tiers.main)} (pi settings.json default)`));
  if (missing.length) {
    console.log(c.yellow(`  ! Not installed: ${missing.join(", ")}`));
  }
}

/** Rebuild + push the bundle for one pi-durable wolf. */
async function syncPiDurable(
  config: CliConfig,
  host: HostEntry,
  hostName: string,
  wolf: RemoteWolf,
): Promise<void> {
  const cfg = wolf.config;
  if (!cfg) {
    console.error(c.red(`Agent on ${hostName} did not return config for '${wolf.id}'.`));
    process.exit(1);
  }

  console.log(c.bold(`Syncing ${cfg.name} (pi-durable) on ${hostName}...`));

  // Resolve the model table here (location vps) and ship it; the VPS never
  // reads ~/.wolfpack. The wolf layer is its own transport / models: keys.
  const models = resolveModelsOrExit(() => resolveRemoteWolfModels(config, cfg));
  console.log(
    c.dim(`  Models:  main=${models.tiers.main.model} smart=${models.tiers.smart.model} fast=${models.tiers.fast.model} (${models.transport})`),
  );

  // Subscription on a VPS wolf: engine steps run on the Max plan through the
  // Agent SDK, authenticated by a long-lived OAuth token shipped into the
  // wolf's .env. Switching back to api needs no cleanup — the api engines
  // never read it.
  const env: Record<string, string> = {};
  if (models.transport === "subscription") {
    const token = readEnvValue(path.join(os.homedir(), ".wolfpack", ".env"), "CLAUDE_CODE_OAUTH_TOKEN");
    if (!token) {
      console.error(c.red(`${cfg.name} is on transport: subscription, but ~/.wolfpack/.env has no CLAUDE_CODE_OAUTH_TOKEN.`));
      console.error(c.dim("  Run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN=<token> to ~/.wolfpack/.env,"));
      console.error(c.dim(`  or switch back: wolfpack config ${cfg.name} --set transport=api`));
      process.exit(1);
    }
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    console.log(c.dim("  Max:     memory + sweep on the subscription; main agent stays on the API key"));
  }

  // Collect extra config (everything except base keys). transport / models
  // pass through; the removed model:/provider: keys are dropped so a stale
  // remote wolf.yaml is cleaned on the first sync, as are memory.model /
  // memory.fastModel.
  const baseKeys = new Set(["id", "name", "runtime", "model", "provider", "role", "specialty", "domains", "extensions", "harness", "bundle"]);
  const extraConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg as Record<string, unknown>)) {
    if (!baseKeys.has(key) && value !== undefined) {
      extraConfig[key] = value;
    }
  }
  // null means unset for the model keys (the agent clears overrides that way).
  if (extraConfig.transport === null) delete extraConfig.transport;
  if (extraConfig.models && typeof extraConfig.models === "object") {
    const tiers = Object.entries(extraConfig.models as Record<string, unknown>).filter(([, v]) => v !== null);
    if (tiers.length) extraConfig.models = Object.fromEntries(tiers);
    else delete extraConfig.models;
  } else if (extraConfig.models === null) {
    delete extraConfig.models;
  }
  if (extraConfig.memory && typeof extraConfig.memory === "object") {
    const { model: _model, fastModel: _fastModel, ...memory } = extraConfig.memory as Record<string, unknown>;
    extraConfig.memory = memory;
  }

  const built = await buildHarnessBundle(
    {
      name: cfg.name,
      role: cfg.role,
      specialty: cfg.specialty,
      domains: cfg.domains ?? [],
      extensions: cfg.extensions ?? [],
      models,
      extraConfig: Object.keys(extraConfig).length > 0 ? extraConfig : undefined,
      // Owner extensions live in the den; this is the hub's copy of it.
      denExtensionsDir: path.join(wolfDir(config, hostName, cfg.name), "den", "extensions"),
    },
    wolf.id,
  );

  if (built.missing.length) {
    console.log(c.yellow(`  ! Skipped extensions: ${built.missing.join(", ")}`));
  }

  // Never upload a bundle that does not even load: run it locally in smoke mode.
  const smoke = await runSmokes(built);
  if (!smoke.ok) {
    console.error(c.red(`✗ The harness bundle fails its ${smoke.stage} check; nothing was uploaded, ${cfg.name} is untouched.`));
    for (const line of smoke.output.trim().split("\n").slice(-12)) console.error(c.dim(`    ${line}`));
    fs.rmSync(built.tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(c.dim("  Smoke:   bundle loads and starts (ok)"));

  // Read and base64 encode the individual files
  const harnessB64 = fs.readFileSync(built.harnessPath).toString("base64");
  const wolfYamlB64 = fs.readFileSync(built.wolfYamlPath).toString("base64");
  const agentsMdB64 = fs.readFileSync(built.agentsMdPath).toString("base64");
  const modelsB64 = fs.readFileSync(built.modelsPath).toString("base64");

  // Package extensions as a map of name -> base64 content
  const extBundleDir = path.join(built.tmpDir, "extensions");
  const extensions: Record<string, string> = {};
  if (fs.existsSync(extBundleDir)) {
    for (const name of fs.readdirSync(extBundleDir)) {
      const extIndex = path.join(extBundleDir, name, "index.js");
      if (fs.existsSync(extIndex)) {
        extensions[name] = fs.readFileSync(extIndex).toString("base64");
      }
    }
  }

  const client = new AgentClient(host);
  // Restart count before the update, to tell a crash loop from the one restart the update causes.
  const baseline = await client.wolfStatus(wolf.id).then((s) => (s as { restarts?: number }).restarts, () => undefined);
  try {
    await client.updateWolfBundle(wolf.id, {
      runtime: "pi-durable",
      harness: harnessB64,
      wolfYaml: wolfYamlB64,
      agentsMd: agentsMdB64,
      models: modelsB64,
      extensions,
      ...(Object.keys(env).length ? { env } : {}),
    });
    console.log(
      c.green(
        `✓ Synced harness + ${built.included.length} extensions — restarted`,
      ),
    );
  } catch (err) {
    console.error(c.red(`Sync failed: ${err}`));
    process.exit(1);
  } finally {
    fs.rmSync(built.tmpDir, { recursive: true, force: true });
  }

  // Watch the wolf come back; a crash loop is rolled back to the previous bundle.
  console.log(c.dim("  Watching the restart (up to 30s)..."));
  const verdict = await watchAfterRestart(client, wolf.id, { baseline });
  if (!verdict.ok) {
    console.error(c.red(`✗ ${cfg.name} is unhealthy after the sync: ${verdict.reason}`));
    if (verdict.rolledBack) console.error(c.yellow("  Restored the previous harness bundle and restarted. The sync did not take."));
    else console.error(c.red(`  Could not roll back (${verdict.rollbackError}). Check the wolf: wolfpack logs ${cfg.name}`));
    process.exit(1);
  }
  console.log(c.green(`✓ ${cfg.name} is healthy after the restart`));

  // Librarian pi-durable wolves also need the standalone KB CLI shipped to
  // /opt/wolfpack-kb/cli.cjs (used by `wolfpack kb <cmd>` for admin ops like
  // status/reorg/rebuild). The harness bundle carries the embedded librarian
  // the sweep timer uses; the CLI binary is a separate artifact.
  //
  // Detection: the pi-durable harness checks `config.memory?.librarian === true`
  // for sweep-manager init — isLibrarianConfig mirrors that, so every wolf that
  // runs the embedded librarian also gets the admin CLI shipped.
  if (isLibrarianConfig(cfg as { extensions?: string[]; memory?: { librarian?: boolean } })) {
    try {
      await provisionKbEngine(host, {
        id: wolf.id,
        name: cfg.name,
        ownerId: cfg.telegram?.ownerId,
      });
    } catch (err) {
      console.error(c.red(`KB engine provisioning failed: ${err}`));
      process.exit(1);
    }
  }
}

/** Rebuild + push the bundle for one wolf on one host. */
async function syncOne(
  config: CliConfig,
  host: HostEntry,
  hostName: string,
  nameOrId: string,
): Promise<void> {
  const client = new AgentClient(host);

  let wolf: RemoteWolf;
  try {
    wolf = (await client.wolfStatus(nameOrId)) as RemoteWolf;
  } catch (err) {
    console.error(c.red(`Could not read '${nameOrId}' on ${hostName}: ${err}`));
    process.exit(1);
  }

  const cfg = wolf.config;
  if (!cfg) {
    console.error(c.red(`Agent on ${hostName} did not return config for '${nameOrId}'.`));
    process.exit(1);
  }
  
  // Report extension drift before syncing
  await reportDrift(cfg.extensions ?? [], wolf);

  // Use pi-durable sync for pi-durable wolves
  if ((cfg as Record<string, unknown>).runtime === "pi-durable") {
    await syncPiDurable(config, host, hostName, wolf);
    return;
  }

  console.log(c.bold(`Syncing ${cfg.name} on ${hostName}...`));
  const built = await buildRemoteBundle({
    name: cfg.name,
    role: cfg.role,
    specialty: cfg.specialty,
    domains: cfg.domains ?? [],
    extensions: cfg.extensions ?? [],
  });
  if (built.missing.length) {
    console.log(c.yellow(`  ! Skipped (not vendored): ${built.missing.join(", ")}`));
  }

  try {
    await client.updateWolfBundle(wolf.id, {
      bundle: built.bundleB64,
      manifest: built.manifest,
    });
    console.log(
      c.green(
        `✓ Synced: ${built.manifest.extensions
          .map((e) => `${e.key}@${e.version}`)
          .join(", ") || "(none)"} — restarted`,
      ),
    );
  } catch (err) {
    console.error(c.red(`Sync failed: ${err}`));
    process.exit(1);
  }

  // Librarian-only: stand up / refresh the host KB engine (Ollama + sweep timer).
  // Gated on the `kb` extension so it only touches hosts running a librarian.
  if (isLibrarian(cfg.extensions ?? [])) {
    try {
      await provisionKbEngine(host, {
        id: wolf.id,
        name: cfg.name,
        ownerId: cfg.telegram?.ownerId,
      });
    } catch (err) {
      console.error(c.red(`KB engine provisioning failed: ${err}`));
      process.exit(1);
    }
    // Deploy the declared-domain registry so the sweep's gate is current.
    const reg = await deployDomainsRegistry();
    console.log(
      reg.ok
        ? c.green(`\u2713 Declared-domain registry deployed (${reg.note})`)
        : c.dim(`  \u00b7 Domain registry not deployed: ${reg.note}`),
    );
  }
}

/** Sync every wolf on every registered host. */
async function syncAll(config: CliConfig): Promise<void> {
  const hosts = Object.entries(config.hosts);
  if (hosts.length === 0) {
    console.log(c.dim("No remote hosts registered. Local wolves are always current."));
    return;
  }
  for (const [hostName, host] of hosts) {
    const client = new AgentClient(host);
    let wolves: RemoteWolf[];
    try {
      const res = (await client.listWolves()) as { wolves: RemoteWolf[] };
      wolves = res.wolves ?? [];
    } catch (err) {
      console.error(c.red(`Skipping ${hostName} (unreachable): ${err}`));
      continue;
    }
    for (const w of wolves) {
      await syncOne(config, host, hostName, w.id);
    }
  }

  await runMeshReconcile();
}

async function reportDrift(
  extKeys: string[],
  wolf: RemoteWolf,
): Promise<void> {
  const bundleExts = (wolf as unknown as Record<string, unknown>).bundle as
    | { extensions?: Array<{ key: string; hash: string; version: string }> }
    | undefined;
  const deployed = new Map(
    (bundleExts?.extensions ?? []).map((e) => [e.key, e]),
  );

  const stale: string[] = [];
  const missing: string[] = [];

  for (const key of extKeys) {
    const local = await stampExtension(key);
    if (!local) continue;
    const remote = deployed.get(key);
    if (!remote) {
      missing.push(key);
    } else if (remote.hash !== local.hash) {
      stale.push(`${key} (${remote.hash.slice(0, 8)}.. → ${local.hash.slice(0, 8)}..)`); 
    }
  }

  if (stale.length || missing.length) {
    console.log(c.dim("  Extension drift:"));
    for (const s of stale) console.log(c.yellow(`    ↻ ${s}`));
    for (const m of missing) console.log(c.yellow(`    + ${m} (new)`));
  } else if (deployed.size > 0) {
    console.log(c.dim("  Extensions: all up to date"));
  }
}

/** Resolve a model table, printing warnings; a config error aborts with its fix. */
function resolveModelsOrExit(resolve: () => ModelTable): ModelTable {
  let table: ModelTable;
  try {
    table = resolve();
  } catch (err) {
    if (err instanceof ModelConfigError) {
      console.error(c.red(err.message));
      process.exit(1);
    }
    throw err;
  }
  for (const w of table.warnings) console.log(c.yellow(`  ! models: ${w}`));
  return table;
}

async function runMeshReconcile(): Promise<void> {
  try {
    console.log(c.dim("\n  Reconciling mesh..."));
    const result = await reconcileMesh();
    if (result.applied === 0) {
      console.log(c.dim("  Mesh: already in sync."));
    } else {
      console.log(c.green(`  \u2713 Mesh: ${result.applied} folder(s) wired.`));
    }
  } catch (err) {
    console.log(c.yellow(`  ! Mesh reconcile skipped: ${err instanceof Error ? err.message : err}`));
  }
}

/** Load check, then start check (createWolfHarness against a throwaway home). */
async function runSmokes(built: Parameters<typeof smokeStartBundle>[0]): Promise<{ ok: boolean; output: string; stage: "load" | "start" }> {
  const load = await smokeCheckBundle(built.harnessPath);
  if (!load.ok) return { ...load, stage: "load" };
  const start = await smokeStartBundle(built);
  return { ...start, stage: "start" };
}
