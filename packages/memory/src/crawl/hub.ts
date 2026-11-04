/**
 * Release a crawl to a hub (hubd) instead of the local KB_OPS inbox.
 *
 * Config (same knobs as the console): `WOLFPACK_HUB_URL` (the hubd base URL) and `WOLFPACK_HUB_TOKEN` (a per-device bearer token from `hubd pair`). Unset URL = the
 * file-write path (`emitCrawl`) is used unchanged.
 *
 * The contributions are built by the same `emitCrawl` (same dedup, same bodies) into a throwaway staging ops dir and then POSTed to
 * `/v1/contributions` with `Authorization: Bearer` (the hub takes the wolf from the token's host). The wolf's `emitted.json` dedup is only kept when every post succeeded; on a failure
 * it is restored, so a retry re-sends (the hub is idempotent on topic + content hash).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { emitCrawl, type EmitCrawlOptions, type EmitCrawlResult } from "./emit.js";

export interface HubTarget {
  baseUrl: string;
  /** Per-device bearer token (worker token of this wolf's host). */
  token?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/** The hub configured in `env` (WOLFPACK_HUB_URL / WOLFPACK_HUB_TOKEN), or undefined. */
export function hubTargetFromEnv(env: Record<string, string | undefined> = process.env): HubTarget | undefined {
  const baseUrl = env.WOLFPACK_HUB_URL?.trim();
  return baseUrl ? { baseUrl, token: env.WOLFPACK_HUB_TOKEN?.trim() || undefined } : undefined;
}

let warnedCreds = false;
/** The hub URL without credentials, query or fragment (safe to show and log). Warns once when credentials were stripped (use WOLFPACK_HUB_TOKEN). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if ((u.username || u.password) && !warnedCreds) {
      warnedCreds = true;
      console.warn("[crawl] the hub URL contains credentials; they are ignored. Put the token in WOLFPACK_HUB_TOKEN.");
    }
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url.replace(/\/\/[^/@\s]*@/g, "//").replace(/\/+$/, "");
  }
}

/** Hub POST timeout. */
export const POST_TIMEOUT_MS = 30_000;

/**
 * Strip secrets from text that may be persisted or shown: URL userinfo, `Bearer …`, `sk-…` keys, `?token=` style query values,
 * and any exact `secrets` given (e.g. the hub token, which a server may echo back).
 */
export function scrubSecrets(text: string, secrets: (string | undefined)[] = []): string {
  let out = text
    .replace(/(\/\/)[^/@\s]*@/g, "$1")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/([?&](?:token|access_token|api_key|apikey|key|secret)=)[^&\s"']+/gi, "$1***");
  for (const t of secrets) if (t && t.length >= 4) out = out.split(t).join("***");
  return out;
}
const scrub = (text: string, hub?: HubTarget): string => scrubSecrets(text, [hub?.token]);

/** POST one contribution as the wolf (30 s timeout). Throws, with credentials scrubbed from the text, on a transport error, a non-2xx, or a 2xx without an id. */
export async function postContribution(hub: HubTarget, wolf: string, contribution: object): Promise<{ id: string; duplicate: boolean }> {
  const where = redactUrl(hub.baseUrl);
  let res: Response;
  try {
    res = await (hub.fetch ?? fetch)(`${where}/v1/contributions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(hub.token ? { Authorization: `Bearer ${hub.token}` } : {}),
      },
      body: JSON.stringify(contribution),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(scrub(`could not reach the hub at ${where}: ${e instanceof Error ? e.message : String(e)}`, hub));
  }
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; duplicate?: unknown; message?: unknown };
  if (!res.ok) throw new Error(scrub(`hub rejected the contribution (${res.status}): ${typeof body.message === "string" ? body.message : "no detail"}`, hub));
  if (typeof body.id !== "string" || !body.id) throw new Error(`hub at ${where} answered ${res.status} without a stored id`);
  return { id: body.id, duplicate: body.duplicate === true };
}

/** Merge `staged` (a staging den's emitted map + bodies) into the real den for the given topic ids; read-merge-write so a concurrent release's entries survive. */
function persistDedup(stagedDen: string, realDen: string, ids: string[]): void {
  if (ids.length === 0) return;
  const read = (p: string): Record<string, string> => {
    try {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  };
  const staged = read(join(stagedDen, "emitted.json"));
  mkdirSync(realDen, { recursive: true });
  const real = read(join(realDen, "emitted.json"));
  for (const id of ids) if (staged[id] !== undefined) real[id] = staged[id];
  const tmp = join(realDen, `emitted.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(real, null, 2) + "\n");
  renameSync(tmp, join(realDen, "emitted.json"));
  const bodies = join(stagedDen, "emitted-bodies");
  if (existsSync(bodies)) cpSync(bodies, join(realDen, "emitted-bodies"), { recursive: true });
}

/**
 * Like `emitCrawl` (real emit), but delivers to the hub. `dest` of the result is the hub URL (credentials stripped).
 * The contributions are built against a STAGING copy of the wolf's dedup (`emitted.json`), posted, and only when every post
 * succeeded is the dedup merged into the real den. A failure or a crash anywhere before that leaves the real dedup untouched, so
 * unsent items are never marked sent and a retry re-sends everything (the hub is idempotent: an already-stored contribution
 * answers 200 `duplicate`).
 */
export async function emitCrawlToHub(runDir: string, hub: HubTarget, opts: Omit<EmitCrawlOptions, "dryRun"> = {}): Promise<EmitCrawlResult> {
  const wolf = opts.wolf ?? process.env.WOLF_NAME ?? "scribe";
  const denLocal = opts.roots?.denLocal ?? join(process.env.WOLF_DEN ?? join(homedir(), "wolves", "den"), "kb");
  const staging = mkdtempSync(join(tmpdir(), "crawl-hub-"));
  const stagedDen = join(staging, "den-kb");
  try {
    mkdirSync(stagedDen, { recursive: true });
    for (const f of ["emitted.json", "emitted-bodies"]) if (existsSync(join(denLocal, f))) cpSync(join(denLocal, f), join(stagedDen, f), { recursive: true });
    const r = emitCrawl(runDir, { ...opts, wolf, dryRun: false, quiet: true, roots: { ...opts.roots, opsRoot: join(staging, "ops"), denLocal: stagedDen } });
    for (const c of r.delta) await postContribution(hub, wolf, c);
    persistDedup(stagedDen, denLocal, r.delta.map((c) => c.denTopicId));
    const dest = `${redactUrl(hub.baseUrl)}/v1/contributions`;
    if (!opts.quiet) console.log(`\n${r.emitted} contribution(s) emitted → ${dest}`);
    return { ...r, dest };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ── hub reads (best effort) ─────────────────────────────────────────────────

async function hubGet(hub: HubTarget, path: string): Promise<{ status: number; body: unknown } | undefined> {
  try {
    const res = await (hub.fetch ?? fetch)(`${redactUrl(hub.baseUrl)}${path}`, {
      headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return undefined;
  }
}

/** The domains registered on the hub (GET /v1/registry/domains), or null when the hub cannot be read. */
export async function listDomainsOnHub(hub: HubTarget): Promise<Set<string> | null> {
  const r = await hubGet(hub, "/v1/registry/domains");
  if (!r || r.status !== 200) return null;
  const list = (r.body as { domains?: { name?: unknown }[] }).domains;
  if (!Array.isArray(list)) return null;
  return new Set(list.map((d) => d.name).filter((n): n is string => typeof n === "string"));
}

/**
 * SEAM (hub endpoint task work-wolfpack-ZBZPAZ9): which den topic ids the hub's curator has already curated for this wolf.
 * Provisional contract: GET /v1/contributions/receipts → `{ curated: string[] }`. Feature-detected: any non-200 (the route
 * does not exist yet: 404/405) or transport error answers `undefined`, meaning "unknown", never "none curated".
 */
export async function readHubReceipts(hub: HubTarget): Promise<Set<string> | undefined> {
  const r = await hubGet(hub, "/v1/contributions/receipts");
  if (!r || r.status !== 200) return undefined;
  const curated = (r.body as { curated?: unknown }).curated;
  return Array.isArray(curated) ? new Set(curated.filter((x): x is string => typeof x === "string")) : undefined;
}

/**
 * SEAM (work-wolfpack-ZBZPAZ9): ask the hub what a release would do, for the dry-run review.
 * Provisional contract: POST /v1/contributions/check `{ items: [{ denTopicId, contentHash }] }` → `{ unchanged: string[] }`
 * (denTopicIds the hub already holds with that hash). Feature-detected like readHubReceipts: undefined = unknown.
 */
export async function checkHubContributions(hub: HubTarget, items: { denTopicId: string; contentHash?: string }[]): Promise<Set<string> | undefined> {
  try {
    const res = await (hub.fetch ?? fetch)(`${redactUrl(hub.baseUrl)}/v1/contributions/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(hub.token ? { Authorization: `Bearer ${hub.token}` } : {}) },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) return undefined;
    const unchanged = ((await res.json().catch(() => ({}))) as { unchanged?: unknown }).unchanged;
    return Array.isArray(unchanged) ? new Set(unchanged.filter((x): x is string => typeof x === "string")) : undefined;
  } catch {
    return undefined;
  }
}
