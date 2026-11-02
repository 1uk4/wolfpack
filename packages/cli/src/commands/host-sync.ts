/**
 * wolfpack host sync [host]
 *
 * Den backup only (removed in feature H3GuSmC). Folder ids are den-<host>-<wolf>.
 *
 * READ-ONLY check of the den backup folders on the hub. It never writes Syncthing
 * config: den folders are owned by the per-wolf instances (wolf-<id>-syncthing)
 * wired by `wolfpack mesh`, and the retired root-level VPS Syncthing must not be
 * used (it would overwrite a live folder with a device id that is not running).
 * A missing folder is reported with a pointer to `wolfpack mesh`.
 */

import path from "node:path";
import { loadConfig, getHost } from "../config.js";
import { c } from "../render.js";
import { AgentClient } from "../agent-client.js";
import { denFolderId, loadDevices } from "../mesh.js";
import { readLocalSyncthing, SyncthingRest } from "../syncthing.js";

export async function hostSync(hostArg?: string): Promise<void> {
  const config = loadConfig();
  const name = hostArg ?? config.defaultHost;
  const host = name ? getHost(config, name) : undefined;
  if (!name || !host) {
    console.error(c.red("No host specified and no default host set."));
    console.error(c.dim("Usage: wolfpack host sync <host>"));
    process.exit(1);
  }

  console.log(c.bold(`\n🔄 Checking den mirrors for ${name}\n`));

  const client = new AgentClient(host);
  const { wolves } = (await client.listWolves()) as {
    wolves: Array<{ id: string; name: string }>;
  };
  if (!wolves.length) {
    console.log(c.dim("No wolves on this host yet."));
    return;
  }

  for (const w of wolves) {
    try {
      const { macDen, warnings } = await ensureDenMirror(name, w);
      console.log(c.green(`  ✓ ${w.name}`) + c.dim(`  ${denFolderId(name, w.id)} → ${macDen}`));
      for (const msg of warnings) console.log(c.yellow(`    ! ${msg}`));
    } catch (err) {
      console.error(c.red(`  ✗ ${w.name}: ${err instanceof Error ? err.message : err}`));
    }
  }

  console.log(c.dim("\nRead-only check. To wire or repair den folders run: wolfpack mesh"));
}

/**
 * Verify a wolf's den backup folder exists on the hub (read-only, idempotent).
 * Never creates or modifies a folder and never talks to the VPS root Syncthing:
 * an existing folder id is left exactly as is; a missing one is an error that
 * points at `wolfpack mesh` (the per-wolf-instance path).
 * Used by `host sync` and `add wolf`.
 */
export async function ensureDenMirror(
  hostName: string,
  wolf: { id: string; name: string },
): Promise<{ macDen: string; folderId: string; warnings: string[] }> {
  const config = loadConfig();
  const local = readLocalSyncthing();
  const mac = new SyncthingRest(local.url, local.apiKey);
  // Same scheme as mesh.ts denFolderId: matches the live den-<host>-<wolf> folders.
  const folderId = denFolderId(hostName, wolf.id);
  const existing = (await mac.listFolders()).find((f) => f.id === folderId);
  if (!existing) {
    throw new Error(`den folder ${folderId} is not wired on the hub; run: wolfpack mesh`);
  }
  // Warn only (never fail, never write): the folder looks wrong for a den backup.
  const warnings: string[] = [];
  if (existing.type !== "receiveonly") {
    warnings.push(`${folderId} is type ${existing.type ?? "unknown"}, expected receiveonly; run: wolfpack mesh --check`);
  }
  const expected = loadDevices().devices[wolf.id]?.deviceId;
  if (expected && !(existing.devices ?? []).some((d) => d.deviceID === expected)) {
    warnings.push(`${folderId} does not list the wolf's Syncthing device ${expected}; run: wolfpack mesh --check`);
  }
  const macDen = existing.path ?? path.join(config.wolvesRoot, hostName, wolf.name, "den");
  return { macDen, folderId, warnings };
}
