/**
 * Host service health checks — Tailscale and Syncthing.
 *
 * These run on the VPS inside the agent and are surfaced through /health so
 * the wolfpack CLI can show tailnet + sync status alongside wolves.
 *
 * Both checks are defensive: a missing binary, stopped service, or unreachable
 * API degrades to `ok: false` with a reason rather than throwing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceHealth } from "./types.js";

const exec = promisify(execFile);

/** Tailscale: installed, backend running, authenticated, tailnet IP, peers online. */
export async function checkTailscale(): Promise<ServiceHealth> {
  try {
    const { stdout } = await exec("tailscale", ["status", "--json"], {
      timeout: 5000,
    });
    const s = JSON.parse(stdout) as {
      BackendState?: string;
      Self?: { TailscaleIPs?: string[]; Online?: boolean };
      Peer?: Record<string, { Online?: boolean }>;
    };

    const state = s.BackendState ?? "Unknown";
    const running = state === "Running";
    const ip = s.Self?.TailscaleIPs?.[0];
    const peers = s.Peer ? Object.values(s.Peer) : [];
    const peersOnline = peers.filter((p) => p.Online).length;

    return {
      name: "tailscale",
      ok: running && !!ip,
      state,
      detail: running
        ? `${ip ?? "no-ip"} · ${peersOnline}/${peers.length} peers online`
        : `backend ${state}`,
    };
  } catch (err) {
    return {
      name: "tailscale",
      ok: false,
      state: "unavailable",
      detail: notFound(err) ? "not installed" : String(err),
    };
  }
}

/**
 * Syncthing: service active + (if an API key is available) REST reachable with
 * aggregate folder completion.
 *
 * Config via env:
 *   SYNCTHING_UNIT     systemd unit to probe (default "syncthing")
 *   SYNCTHING_URL      REST base (default http://127.0.0.1:8384)
 *   SYNCTHING_API_KEY  enables the deeper REST check
 */
export async function checkSyncthing(): Promise<ServiceHealth> {
  const unit = process.env.SYNCTHING_UNIT ?? "syncthing";
  const url = process.env.SYNCTHING_URL ?? "http://127.0.0.1:8384";
  const apiKey = process.env.SYNCTHING_API_KEY;

  // 1. systemd service state
  let active = false;
  try {
    const { stdout } = await exec("systemctl", ["is-active", unit], {
      timeout: 5000,
    });
    active = stdout.trim() === "active";
  } catch {
    // is-active exits non-zero when inactive
  }

  if (!active) {
    return { name: "syncthing", ok: false, state: "inactive", detail: `${unit} not active` };
  }

  // 2. Optional deeper REST check
  if (!apiKey) {
    return {
      name: "syncthing",
      ok: true,
      state: "active",
      detail: "service active (set SYNCTHING_API_KEY for folder status)",
    };
  }

  try {
    const headers = { "X-API-Key": apiKey };
    const connRes = await fetch(`${url}/rest/system/connections`, { headers });
    if (!connRes.ok) throw new Error(`connections HTTP ${connRes.status}`);
    const conn = (await connRes.json()) as {
      connections?: Record<string, { connected?: boolean }>;
    };
    const devices = conn.connections ? Object.values(conn.connections) : [];
    const connected = devices.filter((d) => d.connected).length;

    // Aggregate completion across configured folders
    const cfgRes = await fetch(`${url}/rest/config/folders`, { headers });
    const folders = cfgRes.ok
      ? ((await cfgRes.json()) as Array<{ id: string }>)
      : [];
    let minCompletion = 100;
    for (const f of folders) {
      const compRes = await fetch(
        `${url}/rest/db/completion?folder=${encodeURIComponent(f.id)}`,
        { headers },
      );
      if (compRes.ok) {
        const comp = (await compRes.json()) as { completion?: number };
        minCompletion = Math.min(minCompletion, comp.completion ?? 0);
      }
    }
    const synced = folders.length === 0 || minCompletion >= 100;

    return {
      name: "syncthing",
      ok: true,
      state: synced ? "synced" : "syncing",
      detail: `${connected}/${devices.length} peers · ${folders.length} folders · ${Math.floor(minCompletion)}% synced`,
    };
  } catch (err) {
    return {
      name: "syncthing",
      ok: true,
      state: "active",
      detail: `service active, REST check failed: ${String(err)}`,
    };
  }
}

/** Run both service checks in parallel. */
export async function checkServices(): Promise<ServiceHealth[]> {
  return Promise.all([checkTailscale(), checkSyncthing()]);
}

function notFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
