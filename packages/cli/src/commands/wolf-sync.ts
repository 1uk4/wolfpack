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
import path from "node:path";
import { parse as yamlParse } from "yaml";
import { AgentClient } from "../agent-client.js";
import { buildRemoteBundle } from "../bundle.js";
import {
  loadConfig,
  getHost,
  localWolfDir,
  kbBaseDir,
  librarianDir,
  type CliConfig,
  type HostEntry,
} from "../config.js";
import { isLibrarian, writePiSettings } from "../extensions.js";
import { provisionKbEngine } from "../deployer.js";
import { deployDomainsRegistry } from "../librarian-registry.js";
import { c } from "../render.js";

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
  };
}

export async function wolfSync(
  name: string | undefined,
  opts: SyncOpts,
): Promise<void> {
  const config = loadConfig();

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
    return;
  }

  const host = getHost(config, opts.host);
  if (!host) {
    console.error(c.red(`'${name}' not found locally and no host specified.`));
    process.exit(1);
  }

  const hostName = opts.host ?? config.defaultHost!;
  await syncOne(host, hostName, name);
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

  const missing = writePiSettings(dir, wolf.extensions ?? []);
  console.log(c.green(`\u2713 Reconciled local wolf ${wolf.name} from config`));
  console.log(c.dim(`  .env:    ${Object.keys(managed).join(", ")} (+${kept.length} preserved)`));
  console.log(c.dim(`  Exts:    ${wolf.extensions?.length ? wolf.extensions.join(", ") : "(none)"}`));
  if (missing.length) {
    console.log(c.yellow(`  ! Not installed: ${missing.join(", ")}`));
  }
}

/** Rebuild + push the bundle for one wolf on one host. */
async function syncOne(
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
      await syncOne(host, hostName, w.id);
    }
  }
}
