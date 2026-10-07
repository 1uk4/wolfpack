/**
 * reconcileMesh — make the live Syncthing fabric match the declared config.
 *
 * Pure topology lives in mesh.ts (planMesh). This file is the I/O: gather every
 * wolf across hosts, resolve/record the hub device, then apply each instance's
 * desired folders+devices. The hub is driven over local REST; each remote wolf's
 * Syncthing is driven by a bash script over SSH (reads its API key on-box, curls
 * 127.0.0.1:<guiPort>) — the same key-stays-on-box pattern as den-sync.
 *
 * ADDITIVE for now: we PUT desired devices/folders. Pruning (revocation) is
 * reported by checkMesh() but applied manually until auto-prune lands.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import { loadConfig, getHost, localHostDir, type CliConfig, type HostEntry } from "./config.js";
import { loadRegistry, listDomainNames } from "./domains.js";
import {
  loadDevices,
  saveDevices,
  allocatePorts,
  planMesh,
  isManagedFolderId,
  kbFolderId,
  type DeviceRegistry,
  type MeshDevice,
  type MeshWolf,
  type InstancePlan,
  type PlannedFolder,
} from "./mesh.js";
import {
  readLocalSyncthing,
  localTailscaleIp,
  SyncthingRest,
  buildDevice,
  buildFolder,
} from "./syncthing.js";
import { AgentClient } from "./agent-client.js";
import { scpToHost, execSsh } from "./ssh-helper.js";
import { c } from "./render.js";

// ── gather wolves across all hosts ───────────────────────────────────────────

function roleOf(exts: string[] | undefined): MeshWolf["role"] {
  return exts?.includes("kb") ? "librarian" : "wolf";
}

/** Local wolves from ~/wolves/local/<wolf>/wolf.yaml (domains + role). */
function gatherLocalWolves(config: CliConfig): MeshWolf[] {
  const root = localHostDir(config);
  if (!fs.existsSync(root)) return [];
  const out: MeshWolf[] = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = path.join(root, d.name, "wolf.yaml");
    if (!fs.existsSync(p)) continue;
    try {
      const w = yamlParse(fs.readFileSync(p, "utf8")) as {
        id: string; name: string; domains?: string[]; extensions?: string[];
      };
      out.push({
        id: w.id, name: w.name, host: "local",
        role: roleOf(w.extensions), domains: w.domains ?? [],
      });
    } catch { /* skip */ }
  }
  return out;
}

/** Remote wolves on one host via the agent (status carries domains + bundle). */
async function gatherRemoteWolves(hostName: string, host: HostEntry): Promise<MeshWolf[]> {
  const client = new AgentClient(host);
  const { wolves } = (await client.listWolves()) as { wolves: Array<{ id: string; name: string }> };
  const out: MeshWolf[] = [];
  for (const w of wolves) {
    try {
      const s = (await client.wolfStatus(w.id)) as {
        domains?: string[];
        bundle?: { extensions?: Array<{ key: string }> };
      };
      out.push({
        id: w.id, name: w.name, host: hostName,
        role: roleOf(s.bundle?.extensions?.map((e) => e.key)),
        domains: s.domains ?? [],
      });
    } catch {
      out.push({ id: w.id, name: w.name, host: hostName, role: "wolf", domains: [] });
    }
  }
  return out;
}

export async function gatherWolves(config: CliConfig): Promise<MeshWolf[]> {
  const wolves = gatherLocalWolves(config);
  for (const [name, host] of Object.entries(config.hosts)) {
    try {
      wolves.push(...(await gatherRemoteWolves(name, host)));
    } catch (err) {
      console.error(c.yellow(`  ! Could not reach ${name}: ${err instanceof Error ? err.message : err}`));
    }
  }
  return wolves;
}

// ── hub device ───────────────────────────────────────────────────────────────

export async function ensureHubDevice(reg: DeviceRegistry): Promise<SyncthingRest> {
  const local = readLocalSyncthing();
  const mac = new SyncthingRest(local.url, local.apiKey);
  const id = await mac.myId();
  const ip = localTailscaleIp();
  reg.devices["hub"] = {
    role: "hub",
    host: "local",
    deviceId: id,
    addr: ip ? `tcp://${ip}:22000` : undefined,
  };
  return mac;
}

// ── apply ─────────────────────────────────────────────────────────────────────

/** Apply one instance's plan to the hub (local REST). */
async function applyHub(mac: SyncthingRest, plan: InstancePlan): Promise<void> {
  for (const peer of plan.peers) {
    if (!peer.device.deviceId) continue;
    const addr = peer.device.addr ? [peer.device.addr] : [];
    await mac.putDevice(buildDevice(peer.device.deviceId, peer.key, addr));
  }
  for (const f of plan.folders) {
    const devIds = resolveFolderDeviceIds(f, plan, "hub");
    fs.mkdirSync(f.path, { recursive: true });
    // Syncthing refuses to scan/advertise a folder whose `.stfolder` marker is
    // missing ("folder marker missing" \u2192 0 files offered). It only auto-creates
    // the marker for an empty, self-owned dir \u2014 so a domain dir that was already
    // populated (e.g. by Dewey's sweep) stays stuck forever. Create it ourselves.
    fs.mkdirSync(path.join(f.path, ".stfolder"), { recursive: true });
    await mac.putFolder(buildFolder(f.id, f.path, f.type, devIds));
  }
}

/** Apply one instance's plan to a remote wolf's Syncthing over SSH. */
function applyRemote(
  host: HostEntry,
  instanceKey: string,
  plan: InstancePlan,
  reg: DeviceRegistry,
): void {
  const self = reg.devices[instanceKey];
  if (!self?.guiPort) throw new Error(`No guiPort for ${instanceKey} in devices.yaml`);

  const deviceLines = plan.peers
    .filter((p) => p.device.deviceId)
    .map((p) => {
      const addr = p.device.addr ? `["${p.device.addr}"]` : "[]";
      return putJson(
        `devices/${p.device.deviceId}`,
        `{"deviceID":"${p.device.deviceId}","name":"${p.key}","addresses":${addr},"compression":"metadata","introducer":false}`,
      );
    });

  const folderLines = plan.folders.map((f) => {
    const devIds = resolveFolderDeviceIds(f, plan, instanceKey)
      .map((id) => `{"deviceID":"${id}"}`)
      .join(",");
    return (
      // Create the path AND the `.stfolder` marker, then normalize ownership to
      // the wolf user. The sweep runs as root and can pre-create a domain dir
      // (root-owned, no marker) before mesh runs; without this the wolf's
      // Syncthing errors "folder marker missing" and advertises 0 files.
      `mkdir -p "${f.path}/.stfolder"\n` +
      `chown -R wolf-${instanceKey}:wolf-${instanceKey} "${f.path}"\n` +
      putJson(
        `folders/${f.id}`,
        `{"id":"${f.id}","label":"${f.id}","path":"${f.path}","type":"${f.type}","fsWatcherEnabled":true,"rescanIntervalS":3600,"devices":[${devIds}]}`,
      )
    );
  });

  const script = `#!/usr/bin/env bash
set -euo pipefail
CFG=/home/wolf-${instanceKey}/.local/state/syncthing/config.xml
API=$(grep -o '<apikey>[^<]*</apikey>' "$CFG" | sed 's/<[^>]*>//g')
BASE=http://127.0.0.1:${self.guiPort}
put() { curl -fsS -X PUT -H "X-API-Key: $API" -H 'Content-Type: application/json' -d "$2" "$BASE/rest/config/$1" >/dev/null; }
${deviceLines.join("\n")}
${folderLines.join("\n")}
echo "ok"
`;
  runScript(host, instanceKey, script);
}

/** Owner lists all receivers; a receiver lists only [owner, self]. */
function resolveFolderDeviceIds(f: PlannedFolder, _plan: InstancePlan, selfKey: string): string[] {
  const reg = loadDevices();
  return f.deviceIds
    .map((k) => (k === selfKey ? deviceIdFor(reg, selfKey) : deviceIdFor(reg, k)))
    .filter((x): x is string => !!x);
}

function deviceIdFor(reg: DeviceRegistry, key: string): string | undefined {
  return reg.devices[key]?.deviceId;
}

function putJson(restPath: string, json: string): string {
  // emit a shell `put` call; json is already escaped for double-quote wrapping
  return `put '${restPath}' '${json}'`;
}

function runScript(host: HostEntry, tag: string, script: string): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-mesh-"));
  const file = path.join(tmp, `mesh-${tag}.sh`);
  try {
    fs.writeFileSync(file, script, { mode: 0o755 });
    scpToHost(host, file, `/tmp/wolfpack-mesh-${tag}.sh`);
    const res = execSsh(host, `bash /tmp/wolfpack-mesh-${tag}.sh`);
    if (res.code !== 0) throw new Error(res.stderr.trim() || "remote mesh apply failed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── per-wolf Syncthing provisioning ──────────────────────────────────────────

/**
 * Provision a remote wolf's OWN Syncthing instance (idempotent):
 *   • install + start wolf-<id>-syncthing.service (runs as the wolf user)
 *   • pin the sync listen port + harden options (no discovery/relays/nat)
 *   • return the device id
 * The CLI then records {deviceId, ports, addr} in devices.yaml.
 */
function provisionWolfSyncthing(
  host: HostEntry,
  hostName: string,
  wolfId: string,
  reg: DeviceRegistry,
): MeshDevice {
  const existing = reg.devices[wolfId];
  const { tcpPort, guiPort } = existing?.tcpPort && existing?.guiPort
    ? { tcpPort: existing.tcpPort, guiPort: existing.guiPort }
    : allocatePorts(reg, hostName);

  const user = `wolf-${wolfId}`;
  const home = `/home/${user}`;
  const script = `#!/usr/bin/env bash
set -euo pipefail
USER=${user}
HOME_DIR=${home}
GUI=127.0.0.1:${guiPort}
command -v syncthing >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq syncthing; }
install -d -o $USER -g $USER "$HOME_DIR/.local/state/syncthing"
cat > /etc/systemd/system/${user}-syncthing.service <<UNIT
[Unit]
Description=Wolfpack Syncthing - ${user}
After=network-online.target
Wants=network-online.target
[Service]
User=$USER
Environment=HOME=$HOME_DIR
ExecStart=/usr/bin/syncthing serve --no-browser --no-restart --gui-address=$GUI --home=$HOME_DIR/.local/state/syncthing
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ${user}-syncthing.service
# wait for config + REST
for i in $(seq 1 30); do [ -f "$HOME_DIR/.local/state/syncthing/config.xml" ] && break; sleep 1; done
API=$(grep -o '<apikey>[^<]*</apikey>' "$HOME_DIR/.local/state/syncthing/config.xml" | sed 's/<[^>]*>//g')
for i in $(seq 1 30); do curl -fsS -H "X-API-Key: $API" http://$GUI/rest/system/status >/dev/null 2>&1 && break; sleep 1; done
# harden: tailnet-only, explicit listen port, no discovery/relays
curl -fsS -X PATCH -H "X-API-Key: $API" -H 'Content-Type: application/json' \\
  -d '{"globalAnnounceEnabled":false,"localAnnounceEnabled":false,"relaysEnabled":false,"natEnabled":false,"startBrowser":false,"listenAddresses":["tcp://0.0.0.0:${tcpPort}"]}' \\
  "http://$GUI/rest/config/options" >/dev/null
DEVID=$(sudo -u $USER env HOME=$HOME_DIR syncthing --device-id 2>/dev/null | tail -1)
# open the sync port on the tailnet if ufw is active (best-effort)
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q active; then ufw allow ${tcpPort}/tcp >/dev/null 2>&1 || true; fi
echo "DEVICE_ID=$DEVID"
`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-stprov-"));
  const file = path.join(tmp, "prov.sh");
  try {
    fs.writeFileSync(file, script, { mode: 0o755 });
    scpToHost(host, file, `/tmp/wolfpack-stprov-${wolfId}.sh`);
    const res = execSsh(host, `bash /tmp/wolfpack-stprov-${wolfId}.sh`);
    if (res.code !== 0) throw new Error(res.stderr.trim() || "syncthing provision failed");
    const deviceId = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("DEVICE_ID="))
      ?.slice("DEVICE_ID=".length);
    if (!deviceId || !/^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$/.test(deviceId)) {
      throw new Error(`could not read device id (got: ${res.stdout.trim().slice(-80)})`);
    }
    return {
      role: "wolf",
      host: hostName,
      deviceId,
      guiPort,
      tcpPort,
      addr: `tcp://${host.address}:${tcpPort}`,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

export interface MeshPreview {
  toProvision: string[]; // wolf names needing a new Syncthing instance
  shares: string[]; // human-readable folder wiring intents
  reachableHosts: boolean;
}

/**
 * Compute a human-readable preview of what `reconcileMesh` would do, WITHOUT
 * changing anything. Derived from the logical star rules so it includes wolves
 * that aren't provisioned yet. Used to confirm before applying.
 */
export async function previewMesh(): Promise<MeshPreview> {
  const config = loadConfig();
  const reg = loadDevices();
  const domains = listDomainNames(loadRegistry());
  const wolves = await gatherWolves(config);
  const remote = wolves.filter((w) => w.host !== "local");
  const librarian = wolves.find((w) => w.role === "librarian");

  const toProvision = remote
    .filter((w) => !reg.devices[w.id]?.deviceId)
    .map((w) => `${w.name} (${w.host})`);

  const shares: string[] = [];
  for (const w of remote) shares.push(`den-${w.host}-${w.id}: ${w.name} → hub`);
  if (librarian) {
    for (const d of domains) {
      const subs = remote.filter((w) => w.id !== librarian.id && w.domains.includes(d)).map((w) => w.name);
      shares.push(`kb-${d}: ${librarian.name} → [hub${subs.length ? ", " + subs.join(", ") : ""}]`);
    }
    for (const w of wolves) {
      if (w.id === librarian.id) continue;
      shares.push(`ops: ${w.name} ↔ ${librarian.name} (inbox + receipts)`);
    }
  }
  return { toProvision, shares, reachableHosts: Object.keys(config.hosts).length > 0 };
}

export interface ReconcileResult {
  applied: number;
  skipped: string[];
}

export async function reconcileMesh(): Promise<ReconcileResult> {
  const config = loadConfig();
  const reg = loadDevices();
  const domains = listDomainNames(loadRegistry());
  const wolves = await gatherWolves(config);

  const mac = await ensureHubDevice(reg);

  // Provision a Syncthing instance for any remote wolf that doesn't have one yet
  // (idempotent). Local wolves ride the hub and need no device.
  for (const w of wolves) {
    if (w.host === "local") continue;
    if (reg.devices[w.id]?.deviceId) {
      reg.devices[w.id]!.role = w.role; // keep role fresh
      continue;
    }
    const host = getHost(config, w.host);
    if (!host) continue;
    try {
      const dev = provisionWolfSyncthing(host, w.host, w.id, reg);
      dev.role = w.role;
      reg.devices[w.id] = dev;
      console.log(c.green(`  + provisioned syncthing for ${w.name} (${dev.addr})`));
    } catch (err) {
      console.error(c.yellow(`  ! provision ${w.name} failed: ${err instanceof Error ? err.message : err}`));
    }
  }
  saveDevices(reg);

  const plans = planMesh({ registry: reg, domains, wolves, wolvesRoot: config.wolvesRoot });

  const skipped: string[] = [];
  let applied = 0;
  for (const plan of plans) {
    if (plan.key === "hub") {
      await applyHub(mac, plan);
      applied++;
      continue;
    }
    const dev = reg.devices[plan.key];
    if (!dev || dev.host === "local") { skipped.push(plan.key); continue; }
    const host = getHost(config, dev.host);
    if (!host) { skipped.push(`${plan.key}(no host ${dev.host})`); continue; }
    try {
      applyRemote(host, plan.key, plan, reg);
      applied++;
    } catch (err) {
      skipped.push(`${plan.key}(${err instanceof Error ? err.message : err})`);
    }
  }
  return { applied, skipped };
}

// ── drift check (report-only; makes manual pruning safe) ─────────────────────

export interface MeshDrift {
  instance: string;
  missing: string[]; // desired folders not present
  stale: string[];   // managed folders present but not desired
}

export async function checkMesh(): Promise<MeshDrift[]> {
  const config = loadConfig();
  const reg = loadDevices();
  const domains = listDomainNames(loadRegistry());
  const wolves = await gatherWolves(config);
  const plans = planMesh({ registry: reg, domains, wolves, wolvesRoot: config.wolvesRoot });

  const drift: MeshDrift[] = [];

  // Hub: reachable via local REST.
  const hubPlan = plans.find((p) => p.key === "hub");
  if (hubPlan) {
    try {
      const local = readLocalSyncthing();
      const mac = new SyncthingRest(local.url, local.apiKey);
      const live = new Set((await mac.listFolders()).map((f) => f.id));
      const desired = new Set(hubPlan.folders.map((f) => f.id));
      drift.push(diff("hub", desired, live));
    } catch { /* hub unreachable */ }
  }

  // Remote instances: list folders over SSH.
  for (const plan of plans) {
    if (plan.key === "hub") continue;
    const dev = reg.devices[plan.key];
    if (!dev || dev.host === "local" || !dev.guiPort) continue;
    const host = getHost(config, dev.host);
    if (!host) continue;
    try {
      const ids = remoteFolderIds(host, plan.key, dev.guiPort);
      drift.push(diff(plan.key, new Set(plan.folders.map((f) => f.id)), new Set(ids)));
    } catch { /* unreachable */ }
  }
  return drift.filter((d) => d.missing.length || d.stale.length);
}

function diff(instance: string, desired: Set<string>, live: Set<string>): MeshDrift {
  const missing = [...desired].filter((id) => !live.has(id));
  const stale = [...live].filter((id) => isManagedFolderId(id) && !desired.has(id));
  return { instance, missing, stale };
}

function remoteFolderIds(host: HostEntry, instanceKey: string, guiPort: number): string[] {
  const script = `#!/usr/bin/env bash
set -euo pipefail
CFG=/home/wolf-${instanceKey}/.local/state/syncthing/config.xml
API=$(grep -o '<apikey>[^<]*</apikey>' "$CFG" | sed 's/<[^>]*>//g')
curl -fsS -H "X-API-Key: $API" http://127.0.0.1:${guiPort}/rest/config/folders | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//'
`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-mesh-"));
  const file = path.join(tmp, "ls.sh");
  try {
    fs.writeFileSync(file, script, { mode: 0o755 });
    scpToHost(host, file, `/tmp/wolfpack-mesh-ls-${instanceKey}.sh`);
    const res = execSsh(host, `bash /tmp/wolfpack-mesh-ls-${instanceKey}.sh`);
    if (res.code !== 0) throw new Error(res.stderr.trim());
    return res.stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// avoid unused import error for kbFolderId (kept for callers/readability)
void kbFolderId;
