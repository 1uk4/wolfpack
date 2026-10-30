/** Hub pairing for workerd: `workerd pair <hub-url> <code>` trades a code for a worker token and stores it in hub.json (0600). */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { PairResponseSchema } from "@wolfpack/protocol";

export interface HubConfig {
  hubUrl: string;
  token: string;
  hostId: string;
}

/** ~/.wolfpack/workerd (the ~/.wolfpack convention), or $WORKERD_CONFIG_DIR. */
export const workerdConfigDir = (): string => process.env.WORKERD_CONFIG_DIR ?? join(homedir(), ".wolfpack", "workerd");
export const hubConfigFile = (dir = workerdConfigDir()): string => join(dir, "hub.json");

export function loadHubConfig(dir?: string): HubConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(hubConfigFile(dir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // unpaired
    throw new Error(`cannot read ${hubConfigFile(dir)}: ${(e as Error).message}`);
  }
  const j = JSON.parse(raw) as Partial<HubConfig>;
  if (typeof j.hubUrl !== "string" || typeof j.token !== "string" || typeof j.hostId !== "string") throw new Error(`${hubConfigFile(dir)} is invalid (need hubUrl, token, hostId)`);
  return { hubUrl: j.hubUrl, token: j.token, hostId: j.hostId };
}

export function saveHubConfig(cfg: HubConfig, dir?: string): string {
  const file = hubConfigFile(dir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

/** A warning when the hub URL is plain http to a non-loopback host (the token and pairing code cross the network in clear). */
export function insecureHubWarning(hubUrl: string): string | undefined {
  try {
    const u = new URL(hubUrl);
    const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1" || /^127\./.test(u.hostname);
    if (u.protocol === "http:" && !loopback) return `warning: ${u.origin} is plain http; the worker token would travel unencrypted (use https)`;
  } catch {
    /* an invalid URL fails later with a clearer error */
  }
  return undefined;
}

export interface PairOptions {
  warn?: (m: string) => void;
  dir?: string;
  label?: string;
  fetch?: typeof fetch;
}

/** POST /v1/pair as a worker; stores and returns the config. The host id comes from the code (bound at `hubd pair --host-id`). */
export async function pairWithHub(hubUrl: string, code: string, opts: PairOptions = {}): Promise<HubConfig> {
  const warning = insecureHubWarning(hubUrl);
  if (warning) (opts.warn ?? ((m: string) => console.warn(`workerd: ${m}`)))(warning);
  const base = hubUrl.replace(/\/+$/, "");
  const res = await (opts.fetch ?? fetch)(`${base}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, label: (opts.label ?? hostname()).slice(0, 64), kind: "worker" }),
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(`pairing failed (${res.status}): ${body.message ?? "unknown error"}`);
  const p = PairResponseSchema.parse(body);
  if (!p.hostId) throw new Error("pairing failed: the code is not bound to a host id (mint it with `hubd pair --kind worker --host-id <id>`)");
  const cfg = { hubUrl: base, token: p.token, hostId: p.hostId };
  saveHubConfig(cfg, opts.dir);
  return cfg;
}
