/**
 * Mesh - den-backup Syncthing folders only.
 *
 * KB (kb-<domain>) and librarian-ops lane (ops-inbox/ops-receipts) folders were
 * removed: the hub link carries them now. What remains is the per-wolf den
 * backup, `den-<host>-<wolf>` (VPS wolf sendonly -> Mac hub receiveonly).
 * Den backup only, removed in feature H3GuSmC.
 *
 * `devices.yaml` (~/.wolfpack) holds device ids, ports and tailnet addresses.
 * `planMesh()` is pure; `reconcileMesh` applies it. Neither ever emits or
 * prunes a non-den folder id.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { remotePaths } from "./paths.js";

// ── Registry (devices.yaml) ──────────────────────────────────────────────────

export type DeviceRole = "hub" | "librarian" | "wolf";

export interface MeshDevice {
  role: DeviceRole;
  /** "local" for the Mac hub, else the host name. */
  host: string;
  /** Syncthing device id (filled once the daemon has started at least once). */
  deviceId?: string;
  /** REST/GUI port (127.0.0.1-bound). Unset for the hub (uses the user default). */
  guiPort?: number;
  /** Sync transfer port. Unset for the hub (uses the user default 22000). */
  tcpPort?: number;
  /** Explicit tailnet address other devices dial: tcp://<ip>:<tcpPort>. */
  addr?: string;
}

export interface DeviceRegistry {
  /** key: "hub" | wolf id */
  devices: Record<string, MeshDevice>;
}

/** Reserved per-host port ranges. Wolves allocate upward from the base. */
export const SYNC_TCP_BASE = 22000;
export const SYNC_GUI_BASE = 8384;
export const SYNC_PORT_SPAN = 100; // 22000–22099 / 8384–8483

const REGISTRY_DIR = path.join(os.homedir(), ".wolfpack");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "devices.yaml");

export function loadDevices(): DeviceRegistry {
  try {
    const parsed = (yamlParse(fs.readFileSync(REGISTRY_FILE, "utf8")) ?? {}) as Partial<DeviceRegistry>;
    return { devices: parsed.devices ?? {} };
  } catch {
    return { devices: {} };
  }
}

export function saveDevices(reg: DeviceRegistry): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const tmp = `${REGISTRY_FILE}.tmp`;
  fs.writeFileSync(tmp, yamlStringify(reg));
  fs.renameSync(tmp, REGISTRY_FILE);
}

/**
 * Allocate the lowest free tcp/gui port pair on a host (same offset for both),
 * scanning devices already placed there. Deterministic + recorded = reproducible.
 */
export function allocatePorts(
  reg: DeviceRegistry,
  host: string,
): { tcpPort: number; guiPort: number } {
  const usedTcp = new Set<number>();
  for (const d of Object.values(reg.devices)) {
    if (d.host === host && typeof d.tcpPort === "number") usedTcp.add(d.tcpPort);
  }
  for (let off = 0; off < SYNC_PORT_SPAN; off++) {
    const tcp = SYNC_TCP_BASE + off;
    if (!usedTcp.has(tcp)) return { tcpPort: tcp, guiPort: SYNC_GUI_BASE + off };
  }
  throw new Error(`No free sync port on host ${host} (range ${SYNC_TCP_BASE}–${SYNC_TCP_BASE + SYNC_PORT_SPAN - 1})`);
}

// ── Plan (pure) ──────────────────────────────────────────────────────────────

/** A wolf as the planner needs to see it. */
export interface MeshWolf {
  /** device-registry key == wolf id */
  id: string;
  name: string;
  /** "local" or a host name */
  host: string;
  role: DeviceRole;
}

export interface PlanInput {
  registry: DeviceRegistry;
  /** every wolf across every host (local + remote) */
  wolves: MeshWolf[];
  /** Mac wolves root (for hub paths + den backups) */
  wolvesRoot: string;
}

/** One folder as it should exist on ONE Syncthing instance. */
export interface PlannedFolder {
  id: string;
  /** absolute path ON this instance */
  path: string;
  type: "sendonly" | "receiveonly";
  /** device ids that participate from this instance's view */
  deviceIds: string[];
}

/** The desired config for one Syncthing instance. */
export interface InstancePlan {
  /** registry key: "hub" | wolf id */
  key: string;
  /** peer devices this instance must know (resolved, with addr) */
  peers: Array<{ key: string; device: MeshDevice }>;
  /** folders this instance must host */
  folders: PlannedFolder[];
}

// Path conventions (single source - change here only).
const vpsDen = (id: string) => remotePaths().den(id);
const hubDenBackup = (root: string, host: string, name: string) =>
  path.join(root, host, name, "den");

export const denFolderId = (host: string, id: string) => `den-${host}-${id}`;

/** Is this a folder id the mesh may add or prune? Den folders ONLY. */
export function isManagedFolderId(fid: string): boolean {
  return fid.startsWith("den-");
}

/**
 * Compute the desired per-instance Syncthing config. Pure: no I/O.
 *   den-<host>-<wolf>: owner = wolf (sendonly, VPS only), receiver = hub
 */
export function planMesh(input: PlanInput): InstancePlan[] {
  const { registry, wolves, wolvesRoot } = input;
  // Only VPS wolves with a provisioned Syncthing device take part.
  const remoteWolves = wolves.filter((w) => w.host !== "local" && !!registry.devices[w.id]);
  const byInstance = new Map<string, PlannedFolder[]>();
  const add = (key: string, f: PlannedFolder) => {
    const list = byInstance.get(key) ?? [];
    list.push(f);
    byInstance.set(key, list);
  };
  const hubHasDevice = !!registry.devices["hub"];

  for (const w of remoteWolves) {
    const fid = denFolderId(w.host, w.id);
    add(w.id, { id: fid, path: vpsDen(w.id), type: "sendonly", deviceIds: [w.id, "hub"] });
    if (hubHasDevice) {
      add("hub", {
        id: fid,
        path: hubDenBackup(wolvesRoot, w.host, w.name),
        type: "receiveonly",
        deviceIds: ["hub", w.id],
      });
    }
  }

  const plans: InstancePlan[] = [];
  for (const [key, folders] of byInstance) {
    const peerKeys = new Set<string>();
    for (const f of folders) for (const d of f.deviceIds) if (d !== key) peerKeys.add(d);
    const peers: InstancePlan["peers"] = [];
    for (const pk of peerKeys) {
      const device = registry.devices[pk];
      if (device) peers.push({ key: pk, device });
    }
    plans.push({ key, peers, folders });
  }
  return plans;
}
