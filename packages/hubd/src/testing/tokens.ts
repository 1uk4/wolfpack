/** Test helpers: mint device tokens the way `hubd pair` does (straight into the token store) and register wolves on hosts. No production mint route. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTokenStore, OWNER, type TokenRecord } from "../auth.js";
import { tokensFile } from "../layout.js";
import type { HubServer } from "../server.js";

/** Mint a console (operator) token in `dataDir`. */
export function mintOperatorToken(dataDir: string): string {
  const s = createTokenStore(dataDir);
  return s.redeem(s.mintPairingCode({ kind: "console" }).code, "test-operator", "console").token;
}

/** Mint a worker token bound to `hostId` in `dataDir`. */
export function mintWorkerToken(dataDir: string, hostId: string): string {
  const s = createTokenStore(dataDir);
  return s.redeem(s.mintPairingCode({ kind: "worker", hostId }).code, `test-${hostId}`, "worker", hostId).token;
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/**
 * Register `wolf` on `hostId` (host created if needed) through the registry API with `operator`'s token. A worker token of that host
 * may then act for the wolf. Returns that worker token's headers.
 */
export async function registerWolfOnHost(hub: Pick<HubServer, "url" | "dataDir">, operator: Record<string, string>, wolf: string, hostId: string, extra: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const post = (path: string, body: unknown) => fetch(`${hub.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...operator }, body: JSON.stringify(body) });
  const h = await post("/v1/registry/hosts", { name: hostId });
  if (h.status !== 201 && h.status !== 200 && h.status !== 409) throw new Error(`registering host ${hostId}: ${h.status}`);
  const w = await post("/v1/registry/wolves", { name: wolf, host: hostId, ...extra });
  if (w.status !== 201 && w.status !== 200 && w.status !== 409) throw new Error(`registering wolf ${wolf}: ${w.status} ${await w.text()}`);
  return bearer(mintWorkerToken(hub.dataDir, hostId));
}

/** Headers for the standard test cast: operator + wolves w1 (host h1) and w2 (host h2). */
export async function standardCast(hub: Pick<HubServer, "url" | "dataDir">, domain?: string): Promise<{ operator: Record<string, string>; wolf: Record<string, string>; wolf2: Record<string, string> }> {
  const operator = bearer(mintOperatorToken(hub.dataDir));
  // Registry writes regenerate domains.yaml from the registry, so a test's domain must be registered here to stay declared.
  if (domain) await fetch(`${hub.url}/v1/registry/domains`, { method: "POST", headers: { "Content-Type": "application/json", ...operator }, body: JSON.stringify({ name: domain }) });
  const wolf = await registerWolfOnHost(hub, operator, "w1", "h1");
  const wolf2 = await registerWolfOnHost(hub, operator, "w2", "h2");
  return { operator, wolf, wolf2 };
}

/** Operator headers plus one worker-token header set per wolf; each wolf is registered on its own host `h-<wolf>`. */
export async function wolfCast(hub: Pick<HubServer, "url" | "dataDir">, wolves: string[], domain?: string): Promise<{ operator: Record<string, string>; wolves: Record<string, Record<string, string>> }> {
  const operator = bearer(mintOperatorToken(hub.dataDir));
  if (domain) await fetch(`${hub.url}/v1/registry/domains`, { method: "POST", headers: { "Content-Type": "application/json", ...operator }, body: JSON.stringify({ name: domain }) });
  const out: Record<string, Record<string, string>> = {};
  for (const w of wolves) out[w] = await registerWolfOnHost(hub, operator, w, `h-${w}`);
  return { operator, wolves: out };
}

/** Fixed test secrets, so module-level constants can be used across several data dirs (see `seedTokens`). */
export const OP_TOKEN = "test-operator-token";
export const workerTokenFor = (hostId: string): string => `test-worker-token-${hostId}`;
export const OP = bearer(OP_TOKEN);
export const workerHeaders = (hostId: string): Record<string, string> => bearer(workerTokenFor(hostId));

/**
 * Write a token store into `dataDir` holding the fixed operator token (OP_TOKEN) and one worker token per host id (workerTokenFor).
 * Test only: it writes the same file `hubd pair` writes, with known secrets. Call it before (or after) createHubServer on that dir.
 */
export function seedTokens(dataDir: string, hostIds: string[] = []): void {
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");
  const at = new Date().toISOString();
  const tokens: TokenRecord[] = [
    { id: "tok-test-operator", hash: sha(OP_TOKEN), label: "test-operator", kind: "console", owner: OWNER, createdAt: at },
    ...hostIds.map((h): TokenRecord => ({ id: `tok-test-${h}`, hash: sha(workerTokenFor(h)), label: `test-${h}`, kind: "worker", hostId: h, owner: OWNER, createdAt: at })),
  ];
  const file = tokensFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ tokens, pairings: [] }, null, 2) + "\n", { mode: 0o600 });
}
