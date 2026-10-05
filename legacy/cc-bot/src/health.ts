import { readFileSync } from "node:fs";

export type WolfHealth = {
  lastFire?: string | null;
  lastSuccess?: string | null;
  lastError?: string | null;
  credentialsExpiresAt?: number | null;
};

const HEALTH_DIR = process.env.WOLF_HEALTH_DIR ?? "/var/lib/wolfpack/health";

export function readHealth(wolfName: string): WolfHealth | null {
  try {
    const raw = readFileSync(`${HEALTH_DIR}/${wolfName}.json`, "utf8");
    return JSON.parse(raw) as WolfHealth;
  } catch {
    return null;
  }
}

function relTime(targetMs: number, nowMs: number): string {
  const deltaS = Math.round((targetMs - nowMs) / 1000);
  const abs = Math.abs(deltaS);
  const suffix = deltaS >= 0 ? "" : " ago";
  const prefix = deltaS >= 0 ? "in " : "";
  let unit: string;
  if (abs < 60) unit = `${abs}s`;
  else if (abs < 3600) unit = `${Math.round(abs / 60)}m`;
  else if (abs < 86_400) unit = `${Math.round(abs / 3600)}h`;
  else unit = `${Math.round(abs / 86_400)}d`;
  return `${prefix}${unit}${suffix}`;
}

export function formatHealth(h: WolfHealth | null): string[] {
  if (!h) return ["   ⚪ no health data yet"];
  const now = Date.now();
  const lines: string[] = [];

  if (typeof h.credentialsExpiresAt === "number") {
    const exp = h.credentialsExpiresAt;
    const marker = exp <= now ? "🔴" : exp - now < 86_400_000 ? "🟡" : "🔑";
    const label = exp <= now ? "credentials expired" : "credentials expire";
    lines.push(`   ${marker} ${label} ${relTime(exp, now)}`);
  } else {
    lines.push(`   ⚪ no credentials info`);
  }

  if (h.lastSuccess) {
    const t = Date.parse(h.lastSuccess);
    if (!Number.isNaN(t)) lines.push(`   ✅ last run ${relTime(t, now)}`);
  } else {
    lines.push(`   ⚠️ no successful run recorded`);
  }

  if (h.lastError) {
    const truncated = h.lastError.length > 160
      ? h.lastError.slice(0, 160) + "…"
      : h.lastError;
    lines.push(`   ❌ ${truncated}`);
  }

  return lines;
}
