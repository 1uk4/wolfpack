/**
 * Mesh — the Syncthing connection fabric, computed from config.
 *
 * Topology is a STAR (see memory: wolfpack-kb-distribution):
 *   • Dewey (librarian) is the KB source — sendonly `kb-<domain>` to subscribers.
 *   • Each VPS wolf runs its OWN Syncthing (per-unix-user). It peers with exactly
 *     two devices: Dewey (receive KB) and the Mac hub (send its den backup).
 *   • The Mac hub receives every den (backup) + every declared domain (your read
 *     access + backup). Local wolves are NOT separate devices — they run as you
 *     and read the hub's shared `knowledge/base` directly.
 *
 * `devices.yaml` (~/.wolfpack) is the mesh source of truth: device ids, ports,
 * and tailnet addresses. `planMesh()` is pure — it turns the registry + wolf
 * config into the exact per-instance folder/device graph that `reconcileMesh`
 * applies idempotently (with pruning) to each live Syncthing.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

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
  /** declared domains this wolf subscribes to */
  domains: string[];
}

export interface PlanInput {
  registry: DeviceRegistry;
  /** declared domain names */
  domains: string[];
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

// Path conventions (single source — change here only).
const vpsKbBase = (id: string) => `/home/wolf-${id}/knowledge/base`;
const vpsDen = (id: string) => `/home/wolf-${id}/den`;
const hubKbBase = (root: string) => path.join(root, "knowledge", "base");
const hubDenBackup = (root: string, host: string, name: string) =>
  path.join(root, host, name, "den");

export const denFolderId = (host: string, id: string) => `den-${host}-${id}`;
export const kbFolderId = (domain: string) => `kb-${domain}`;

export const opsInboxId = (wolfName: string) => `ops-inbox-${wolfName}`;
export const opsReceiptsId = (wolfName: string) => `ops-receipts-${wolfName}`;

/** Is this registry key / id a wolfpack-managed folder we may prune? */
export function isManagedFolderId(fid: string): boolean {
  return (
    fid.startsWith("kb-") || fid.startsWith("den-") || fid.startsWith("ops-")
  );
}

/**
 * Compute the desired per-instance Syncthing config from the registry + wolves.
 * Pure: no I/O. The returned InstancePlans are what reconcileMesh applies.
 *
 * Star rules:
 *   den-<host>-<wolf>:  owner = wolf (sendonly, VPS only), receivers = [hub]
 *   kb-<domain>:        owner = librarian (sendonly), receivers = [hub] ∪ {VPS
 *                       wolves subscribed to <domain>}
 *   Owner instance lists ALL receivers; each receiver lists only [owner, self].
 */
export function planMesh(input: PlanInput): InstancePlan[] {
  const { registry, domains, wolves, wolvesRoot } = input;
  const librarian = wolves.find((w) => w.role === "librarian");
  // KB source device: the librarian's own device if remote, or the HUB if the
  // librarian runs locally (it writes the hub's KB base directly - librarian and
  // hub collapse into one device).
  const libKey = librarian ? (librarian.host === "local" ? "hub" : librarian.id) : null;
  const libOps = librarian
    ? librarian.host === "local"
      ? `${wolvesRoot}/librarian`
      : `/home/wolf-${librarian.id}/librarian`
    : "";

  // Only VPS wolves are their own Syncthing devices; local wolves ride the hub.
  // A wolf participates only once it has a registered Syncthing device (i.e. its
  // per-wolf instance has been provisioned) \u2014 otherwise we'd wire a folder to a
  // device that doesn't exist.
  const remoteWolves = wolves.filter(
    (w) => w.host !== "local" && !!registry.devices[w.id],
  );

  // Accumulate folders per instance key.
  const byInstance = new Map<string, PlannedFolder[]>();
  const add = (key: string, f: PlannedFolder) => {
    const list = byInstance.get(key) ?? [];
    list.push(f);
    byInstance.set(key, list);
  };

  const hubHasDevice = !!registry.devices["hub"];

  // ── den backups: each remote wolf → hub ──
  for (const w of remoteWolves) {
    const fid = denFolderId(w.host, w.id);
    // owner (the wolf): sendonly, knows the hub
    add(w.id, {
      id: fid,
      path: vpsDen(w.id),
      type: "sendonly",
      deviceIds: [w.id, "hub"],
    });
    // hub: receiveonly backup
    if (hubHasDevice) {
      add("hub", {
        id: fid,
        path: hubDenBackup(wolvesRoot, w.host, w.name),
        type: "receiveonly",
        deviceIds: ["hub", w.id],
      });
    }
  }

  // KB domains: source (librarian device, or hub for a local librarian) -> subs
  if (librarian && libKey) {
    const localLib = librarian.host === "local";
    for (const domain of domains) {
      const fid = kbFolderId(domain);
      const subscribers = remoteWolves
        .filter((w) => w.id !== librarian.id && w.domains.includes(domain))
        .map((w) => w.id);
      // Hub receives every domain (access + backup) UNLESS it is the source.
      const hubReceives = hubHasDevice && !localLib;
      const receivers = [...(hubReceives ? ["hub"] : []), ...subscribers];

      add(libKey, {
        id: fid,
        path: localLib
          ? path.join(hubKbBase(wolvesRoot), "domains", domain)
          : vpsKbBase(librarian.id) + `/domains/${domain}`,
        type: "sendonly",
        deviceIds: [libKey, ...receivers],
      });
      if (hubReceives) {
        add("hub", {
          id: fid,
          path: path.join(hubKbBase(wolvesRoot), "domains", domain),
          type: "receiveonly",
          deviceIds: ["hub", libKey],
        });
      }
      for (const sid of subscribers) {
        add(sid, {
          id: fid,
          path: vpsKbBase(sid) + `/domains/${domain}`,
          type: "receiveonly",
          deviceIds: [sid, libKey],
        });
      }
    }
  }

  // ── librarian-ops lanes: wolf \u2192 Dewey (inbox) + Dewey \u2192 wolf (receipts) ──
  //    Local wolves share the hub filesystem, so their lane endpoint is the hub
  //    device. Remote wolves use their own device. (kb-feed is delivered inside
  //    the domain folders, so no separate feed lane is needed.)
  const libAvailable = !!librarian && (libKey === "hub" ? hubHasDevice : !!registry.devices[librarian!.id]);
  if (librarian && libKey && libAvailable) {
    for (const w of wolves) {
      if (w.id === librarian.id) continue;
      let senderKey: string;
      let senderOps: string;
      if (w.host === "local") {
        if (!hubHasDevice) continue;
        senderKey = "hub";
        senderOps = `${wolvesRoot}/librarian`;
      } else {
        if (!registry.devices[w.id]) continue;
        senderKey = w.id;
        senderOps = `/home/wolf-${w.id}/librarian`;
      }
      // Local wolf + local librarian = same hub device, no lane needed.
      if (senderKey === libKey) continue;
      const wn = w.name;
      // inbox: sender (sendonly) -> librarian (receiveonly)
      add(senderKey, {
        id: opsInboxId(wn),
        path: `${senderOps}/inbox/${wn}`,
        type: "sendonly",
        deviceIds: [senderKey, libKey],
      });
      add(libKey, {
        id: opsInboxId(wn),
        path: `${libOps}/inbox/${wn}`,
        type: "receiveonly",
        deviceIds: [libKey, senderKey],
      });
      // receipts: librarian (sendonly) -> sender (receiveonly)
      add(libKey, {
        id: opsReceiptsId(wn),
        path: `${libOps}/receipts/${wn}`,
        type: "sendonly",
        deviceIds: [libKey, senderKey],
      });
      add(senderKey, {
        id: opsReceiptsId(wn),
        path: `${senderOps}/receipts/${wn}`,
        type: "receiveonly",
        deviceIds: [senderKey, libKey],
      });
    }
  }

  // ── assemble InstancePlans with resolved peers ──
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
