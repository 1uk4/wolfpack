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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The hub URL without credentials, query or fragment (safe to show and log). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
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

/** Strip `user:pass@` from any URL inside an error text. */
const scrub = (text: string): string => text.replace(/(\/\/)[^/@\s]*@/g, "$1");

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
    throw new Error(scrub(`could not reach the hub at ${where}: ${e instanceof Error ? e.message : String(e)}`));
  }
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; duplicate?: unknown; message?: unknown };
  if (!res.ok) throw new Error(scrub(`hub rejected the contribution (${res.status}): ${typeof body.message === "string" ? body.message : "no detail"}`));
  if (typeof body.id !== "string" || !body.id) throw new Error(`hub at ${where} answered ${res.status} without a stored id`);
  return { id: body.id, duplicate: body.duplicate === true };
}

/**
 * Like `emitCrawl` (real emit), but delivers to the hub. `dest` of the result is the hub URL (credentials stripped). If emitCrawl or
 * any post fails, the wolf's `emitted.json` dedup is restored, so a retry re-sends everything; the hub is idempotent
 * (an already-stored contribution answers 200 `duplicate`), so only the missing ones land.
 */
export async function emitCrawlToHub(runDir: string, hub: HubTarget, opts: Omit<EmitCrawlOptions, "dryRun"> = {}): Promise<EmitCrawlResult> {
  const wolf = opts.wolf ?? process.env.WOLF_NAME ?? "scribe";
  const denLocal = opts.roots?.denLocal ?? join(process.env.WOLF_DEN ?? join(homedir(), "wolves", "den"), "kb");
  const emittedPath = join(denLocal, "emitted.json");
  const before = existsSync(emittedPath) ? readFileSync(emittedPath, "utf-8") : undefined;
  const staging = mkdtempSync(join(tmpdir(), "crawl-hub-"));
  try {
    let r: EmitCrawlResult;
    try {
      r = emitCrawl(runDir, { ...opts, wolf, dryRun: false, quiet: true, roots: { ...opts.roots, opsRoot: staging, denLocal } });
      for (const c of r.delta) await postContribution(hub, wolf, c);
    } catch (e) {
      if (before !== undefined) writeFileSync(emittedPath, before);
      else rmSync(emittedPath, { force: true });
      throw e;
    }
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
