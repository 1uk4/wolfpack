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

import { AgentClient } from "../agent-client.js";
import { buildRemoteBundle } from "../bundle.js";
import { loadConfig, getHost, type CliConfig, type HostEntry } from "../config.js";
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

  const host = getHost(config, opts.host);
  if (!host) {
    // No host → local wolf.
    console.log(
      c.dim(
        `'${name}' is local — extensions load from the repo directly, always current. Nothing to sync.`,
      ),
    );
    return;
  }

  const hostName = opts.host ?? config.defaultHost!;
  await syncOne(host, hostName, name);
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
