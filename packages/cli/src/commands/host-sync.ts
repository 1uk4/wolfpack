/**
 * wolfpack host sync [host]
 *
 * Wire up (or re-apply) Syncthing den mirrors for every wolf on a host:
 *   VPS /home/wolf-<id>/den  (send-only, authoritative)
 *     → Mac ~/wolves/<host>/<wolf>/den  (receive-only backup)
 *
 * Idempotent: per-item REST/PUT config on both ends, additive, safe to re-run
 * ("push a resync"). The Mac side is driven via local Syncthing REST; the VPS
 * side via SSH (its API key is read on-box and never leaves it).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, getHost, type HostEntry } from "../config.js";
import { c } from "../render.js";
import { AgentClient } from "../agent-client.js";
import { scpToHost, execSsh } from "../ssh-helper.js";
import {
  readLocalSyncthing,
  localTailscaleIp,
  SyncthingRest,
  buildDevice,
  buildFolder,
} from "../syncthing.js";

export async function hostSync(hostArg?: string): Promise<void> {
  const config = loadConfig();
  const name = hostArg ?? config.defaultHost;
  const host = name ? getHost(config, name) : undefined;
  if (!name || !host) {
    console.error(c.red("No host specified and no default host set."));
    console.error(c.dim("Usage: wolfpack host sync <host>"));
    process.exit(1);
  }

  console.log(c.bold(`\n🔄 Syncing den mirrors for ${name}\n`));

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
      const { vpsDen, macDen } = await ensureDenMirror(name, host, w);
      console.log(c.green(`  ✓ ${w.name}`) + c.dim(`  ${vpsDen} → ${macDen}`));
    } catch (err) {
      console.error(c.red(`  ✗ ${w.name}: ${err instanceof Error ? err.message : err}`));
    }
  }

  console.log(
    c.dim(
      `\nSyncthing will connect over the tailnet (:22000) and mirror dens into ~/wolves/${name}/.`,
    ),
  );
}

/**
 * Ensure a single wolf's den mirror exists on both ends (idempotent).
 * Reusable by `host sync` (reconciler) and `add wolf` (auto-wire on create).
 */
export async function ensureDenMirror(
  hostName: string,
  host: HostEntry,
  wolf: { id: string; name: string },
): Promise<{ vpsDen: string; macDen: string }> {
  const config = loadConfig();
  const local = readLocalSyncthing();
  const mac = new SyncthingRest(local.url, local.apiKey);
  const macId = await mac.myId();
  const macIp = localTailscaleIp();
  const macAddr = macIp ? `tcp://${macIp}:22000` : "dynamic";

  const folderId = `${hostName}-${wolf.id}-den`;
  const vpsDen = `/home/wolf-${wolf.id}/den`;
  const macDen = path.join(config.wolvesRoot, hostName, wolf.name, "den");

  // VPS side: pair Mac + create send-only folder; returns VPS device id.
  const vpsDeviceId = configureVps(host, {
    folderId,
    den: vpsDen,
    macId,
    macName: os.hostname(),
    macAddr,
  });

  // Mac side: ensure path, pair VPS, create receive-only folder.
  fs.mkdirSync(macDen, { recursive: true });
  await mac.putDevice(buildDevice(vpsDeviceId, hostName, [`tcp://${host.address}:22000`]));
  await mac.putFolder(buildFolder(folderId, macDen, "receiveonly", [macId, vpsDeviceId]));

  return { vpsDen, macDen };
}

/**
 * Configure the VPS Syncthing over SSH: read its own API key, pair the Mac
 * device, and create a send-only folder for the wolf's den. Returns the VPS
 * Syncthing device id (last line of output).
 */
function configureVps(
  host: HostEntry,
  opts: { folderId: string; den: string; macId: string; macName: string; macAddr: string },
): string {
  const { folderId, den, macId, macName, macAddr } = opts;
  const script = `#!/usr/bin/env bash
set -euo pipefail
CFG=/root/.local/state/syncthing/config.xml
[ -f "$CFG" ] || CFG=/root/.config/syncthing/config.xml
API=$(grep -o '<apikey>[^<]*</apikey>' "$CFG" | sed 's/<[^>]*>//g')
BASE=http://127.0.0.1:8384
VPS_ID=$(HOME=/root syncthing --device-id)

# Pair the Mac device (additive).
curl -fsS -X PUT -H "X-API-Key: $API" -H 'Content-Type: application/json' \\
  -d '{"deviceID":"${macId}","name":"${macName}","addresses":["${macAddr}"],"autoAcceptFolders":false}' \\
  "$BASE/rest/config/devices/${macId}" >/dev/null

# Send-only den folder shared with the Mac.
curl -fsS -X PUT -H "X-API-Key: $API" -H 'Content-Type: application/json' \\
  -d '{"id":"${folderId}","label":"${folderId}","path":"${den}","type":"sendonly","fsWatcherEnabled":true,"rescanIntervalS":3600,"devices":[{"deviceID":"'"$VPS_ID"'"},{"deviceID":"${macId}"}]}' \\
  "$BASE/rest/config/folders/${folderId}" >/dev/null

echo "$VPS_ID"
`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-st-"));
  const file = path.join(tmp, "syncthing-setup.sh");
  try {
    fs.writeFileSync(file, script, { mode: 0o755 });
    scpToHost(host, file, "/tmp/wolfpack-st.sh");
    const res = execSsh(host, "bash /tmp/wolfpack-st.sh");
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || "VPS syncthing config failed");
    }
    const deviceId = res.stdout
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .reverse()
      .find((l) => /^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$/.test(l));
    if (!deviceId) {
      throw new Error(`Could not read VPS device id (got: ${res.stdout.trim()})`);
    }
    return deviceId;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
