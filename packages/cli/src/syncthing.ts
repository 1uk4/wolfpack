/**
 * Syncthing helpers — drive the local (Mac) Syncthing over its REST API and
 * build device/folder configs. The remote (VPS) Syncthing is driven over SSH
 * (see host-sync), so its API key never leaves the box.
 *
 * All writes are per-item PUTs (additive) — they never replace whole config,
 * so pre-existing folders/devices are untouched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface SyncthingLocal {
  url: string;
  apiKey: string;
}

/** Candidate config.xml locations for a local Syncthing (macOS + Linux). */
function macConfigCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "Library/Application Support/Syncthing/config.xml"),
    path.join(home, ".local/state/syncthing/config.xml"),
    path.join(home, ".config/syncthing/config.xml"),
  ];
}

/** Read the local Syncthing GUI address + API key from its config.xml. */
export function readLocalSyncthing(): SyncthingLocal {
  const file = macConfigCandidates().find((f) => fs.existsSync(f));
  if (!file) {
    throw new Error(
      "Local Syncthing config.xml not found. Is Syncthing installed and run at least once?",
    );
  }
  const xml = fs.readFileSync(file, "utf8");
  const gui = xml.match(/<gui[\s\S]*?<\/gui>/)?.[0] ?? xml;
  const apiKey = gui.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
  const address = gui.match(/<address>([^<]+)<\/address>/)?.[1] ?? "127.0.0.1:8384";
  if (!apiKey) throw new Error("Could not read Syncthing API key from config.xml");
  return { url: `http://${address}`, apiKey };
}

/** The Mac's Tailscale IPv4 (for the VPS to reach us), or undefined. */
export function localTailscaleIp(): string | undefined {
  for (const bin of ["/opt/homebrew/bin/tailscale", "tailscale"]) {
    try {
      const out = execFileSync(bin, ["ip", "-4"], { encoding: "utf8" }).trim();
      const ip = out.split("\n")[0]?.trim();
      if (ip) return ip;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Device config object for a Syncthing REST PUT. */
export function buildDevice(deviceId: string, name: string, addresses: string[]) {
  return {
    deviceID: deviceId,
    name,
    addresses: addresses.length ? addresses : ["dynamic"],
    compression: "metadata",
    introducer: false,
    paused: false,
    autoAcceptFolders: false,
  };
}

/** Folder config object for a Syncthing REST PUT. */
export function buildFolder(
  id: string,
  folderPath: string,
  type: "sendonly" | "receiveonly" | "sendreceive",
  deviceIds: string[],
) {
  return {
    id,
    label: id,
    path: folderPath,
    type,
    devices: deviceIds.map((deviceID) => ({ deviceID })),
    fsWatcherEnabled: true,
    rescanIntervalS: 3600,
  };
}

/** Minimal Syncthing REST client (one instance). */
export class SyncthingRest {
  constructor(
    private url: string,
    private apiKey: string,
  ) {}

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`Syncthing ${method} ${path} -> ${res.status}: ${await res.text()}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  async myId(): Promise<string> {
    const s = (await this.req("GET", "/rest/system/status")) as { myID: string };
    return s.myID;
  }

  async putDevice(device: ReturnType<typeof buildDevice>): Promise<void> {
    await this.req("PUT", `/rest/config/devices/${device.deviceID}`, device);
  }

  async putFolder(folder: ReturnType<typeof buildFolder>): Promise<void> {
    await this.req("PUT", `/rest/config/folders/${folder.id}`, folder);
  }
}
