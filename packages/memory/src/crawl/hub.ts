/**
 * Release a crawl to a hub (hubd) instead of the local KB_OPS inbox.
 *
 * Config (same knobs as the console): `WOLFPACK_HUB_URL` (the hubd base URL) and `WOLFPACK_HUB_TOKEN` (a per-device bearer token from `hubd pair`). Unset URL = the
 * file-write path (`emitCrawl`) is used unchanged.
 *
 * The contributions are built by the same `emitCrawl` (same dedup, same bodies) into a throwaway staging ops dir and then POSTed to
 * `/v1/contributions` with `Authorization: Bearer` (the hub takes the wolf from the token's host). The wolf's `emitted.json` dedup records exactly the entries the hub
 * accepted, even when a later post aborts the release, so a retry sends only the rest (the hub is idempotent on topic + content hash anyway).
 * A 400 carrying `details.reason: secret_detected` refuses ONE entry (the others still go); any other failure aborts the release.
 */
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { safeSegment } from "@wolfpack/kb/shared";
import { SECRET_REFUSAL_REASON } from "@wolfpack/protocol";
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
    return url.replace(/\/\/[^/@\s]*@/g, "//").replace(/[?#].*$/, "").replace(/\/+$/, "");
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

/** A short, value-free reference to a den topic id (first 8 hex of its sha256), the same one the hub puts in its refusal. */
export function entryRef(denTopicId: string): string {
  return createHash("sha256").update(denTopicId).digest("hex").slice(0, 8);
}

/** The hub refused this contribution because it may hold a secret (400 with details.reason secret_detected). Permanent for this content: retrying the same entry is refused again. */
export class HubRejectedError extends Error {
  constructor(message: string, readonly denTopicId: string) {
    super(message);
    this.name = "HubRejectedError";
  }
}

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
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; duplicate?: unknown; message?: unknown; details?: { reason?: unknown } };
  if (!res.ok) {
    const text = scrub(`hub rejected the contribution (${res.status}): ${typeof body.message === "string" ? body.message : "no detail"}`, hub);
    // Only the secret refusal is per-entry (permanent for this content); every other failure, 400 included, is systemic and aborts the release.
    if (res.status === 400 && body.details?.reason === SECRET_REFUSAL_REASON) throw new HubRejectedError(text, String((contribution as { denTopicId?: unknown }).denTopicId ?? "?"));
    throw new Error(text);
  }
  if (typeof body.id !== "string" || !body.id) throw new Error(`hub at ${where} answered ${res.status} without a stored id`);
  return { id: body.id, duplicate: body.duplicate === true };
}

/** Merge `staged` (a staging den's emitted map + bodies) into the real den for the given topic ids; read-merge-write so a concurrent release's entries survive. */
export function persistDedup(stagedDen: string, realDen: string, ids: string[]): void {
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
  // Bodies are merged per sent id (atomic file copy), never wholesale: a concurrent release's bodies are not overwritten.
  const bodies = join(stagedDen, "emitted-bodies");
  if (existsSync(bodies)) {
    mkdirSync(join(realDen, "emitted-bodies"), { recursive: true });
    for (const id of ids) {
      let name: string;
      try {
        name = `${safeSegment(id, "den topic id")}.md`;
      } catch (e) {
        // the posts already succeeded: one odd id must not abort the dedup write
        console.warn(`crawl: skipped the dedup body for "${String(id).slice(0, 60)}": ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const from = join(bodies, name);
      if (!existsSync(from)) continue;
      const to = join(realDen, "emitted-bodies", name);
      const t = `${to}.${process.pid}.${Date.now()}.tmp`;
      try {
        copyFileSync(from, t);
        renameSync(t, to);
      } catch (e) {
        rmSync(t, { force: true });
        console.warn(`crawl: could not keep the dedup body ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

/**
 * Like `emitCrawl` (real emit), but delivers to the hub. `dest` of the result is the hub URL (credentials stripped).
 * The contributions are built against a STAGING copy of the wolf's dedup (`emitted.json`) and posted one by one. The entries the hub accepted are
 * merged into the real den afterwards, also when a later post aborts the release (401/403/5xx/other 400); refused and unsent entries are never marked
 * sent. A crash before the first post leaves the real dedup untouched. A retry therefore sends only what is not recorded (the hub is idempotent: an
 * already-stored contribution answers 200 `duplicate`).
 */
export async function emitCrawlToHub(runDir: string, hub: HubTarget, opts: Omit<EmitCrawlOptions, "dryRun"> = {}): Promise<EmitCrawlResult & { warnings?: string[] }> {
  const wolf = opts.wolf ?? process.env.WOLF_NAME ?? "scribe";
  const denLocal = opts.roots?.denLocal ?? join(process.env.WOLF_DEN ?? join(homedir(), "wolves", "den"), "kb");
  const staging = mkdtempSync(join(tmpdir(), "crawl-hub-"));
  const stagedDen = join(staging, "den-kb");
  try {
    mkdirSync(stagedDen, { recursive: true });
    for (const f of ["emitted.json", "emitted-bodies"]) if (existsSync(join(denLocal, f))) cpSync(join(denLocal, f), join(stagedDen, f), { recursive: true });
    const r = emitCrawl(runDir, { ...opts, wolf, dryRun: false, quiet: true, roots: { ...opts.roots, opsRoot: join(staging, "ops"), denLocal: stagedDen } });
    // A secret-refused entry (400 + secret_detected) does not stop the others and is never marked sent; any other failure aborts the release, with the entries already accepted still recorded (finally below).
    const sent: string[] = [];
    const rejected: { denTopicId: string; message: string }[] = [];
    const warnings: string[] = [];
    let unwinding = true; // true until the post loop finished without throwing
    try {
      for (const c of r.delta) {
        try {
          await postContribution(hub, wolf, c);
          sent.push(c.denTopicId);
        } catch (e) {
          if (!(e instanceof HubRejectedError)) throw e;
          rejected.push({ denTopicId: c.denTopicId, message: e.message });
          console.error(`crawl: the hub REFUSED entry ${entryRef(c.denTopicId)}: ${e.message}`);
        }
      }
      unwinding = false;
    } finally {
      // Entries the hub took are recorded even when a later post aborts the release, so a retry does not re-send them.
      try {
        persistDedup(stagedDen, denLocal, sent);
      } catch (e) {
        const msg = `could not record the ${sent.length} sent entries in the wolf's dedup (${e instanceof Error ? e.message : String(e)}); a re-release may send them again (the hub ignores exact duplicates)`;
        // While already unwinding from a post error, that error is the one to report: do not mask it. On the success path surface it as a warning.
        if (unwinding) console.warn(`crawl: ${msg}`);
        else warnings.push(msg);
      }
    }
    const dest = `${redactUrl(hub.baseUrl)}/v1/contributions`;
    if (!opts.quiet) console.log(`\n${sent.length} contribution(s) emitted → ${dest}${rejected.length ? ` (${rejected.length} refused by the hub)` : ""}`);
    return { ...r, emitted: sent.length, dest, ...(rejected.length ? { rejected } : {}), ...(warnings.length ? { warnings } : {}) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ── hub reads (best effort) ─────────────────────────────────────────────────

type HubReply = { status: number; body: unknown } | { error: string };

/** Why a hub read is "unknown", without a URL or token (safe to show). */
function reasonOf(what: string, r: HubReply): string {
  if ("error" in r) return `${what}: hub unreachable`;
  const msg = (r.body as { message?: unknown })?.message;
  const detail = typeof msg === "string" ? `: ${scrubSecrets(msg).slice(0, 160)}` : "";
  if (r.status === 404 || r.status === 405) return `${what}: this hub does not have the route (older hub)${detail}`;
  if (r.status === 401) return `${what}: the hub token was refused (401)`;
  return `${what}: hub answered ${r.status}${detail}`;
}

async function hubCall(hub: HubTarget, path: string, init?: { body: unknown }): Promise<HubReply> {
  try {
    const res = await (hub.fetch ?? fetch)(`${redactUrl(hub.baseUrl)}${path}`, {
      method: init ? "POST" : "GET",
      headers: { ...(init ? { "Content-Type": "application/json" } : {}), ...(hub.token ? { Authorization: `Bearer ${hub.token}` } : {}) },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { error: "unreachable" };
  }
}

const wolfQuery = (wolf?: string): string => (wolf ? `?wolf=${encodeURIComponent(wolf)}` : "");

/** The domains registered on the hub (GET /v1/registry/domains), or null when the hub cannot be read. */
export async function listDomainsOnHub(hub: HubTarget): Promise<Set<string> | null> {
  const r = await hubCall(hub, "/v1/registry/domains");
  if ("error" in r || r.status !== 200) return null;
  const list = (r.body as { domains?: { name?: unknown }[] }).domains;
  if (!Array.isArray(list)) return null;
  return new Set(list.map((d) => d.name).filter((n): n is string => typeof n === "string"));
}

/** A hub read that can fail: the value, or undefined ("unknown") with a `reason` to show the user. */
export interface HubRead<T> {
  value?: T;
  reason?: string;
}

/**
 * Which den topic ids the hub's curator has already curated for `wolf` (work-wolfpack-ZBZPAZ9).
 * GET /v1/contributions/receipts?wolf=<wolf> → `{ curated: string[] }`. `value` undefined = unknown (older hub, 400 for a host with several
 * wolves, unreachable ...), never "none curated"; `reason` says why.
 */
export async function readHubReceiptsDetailed(hub: HubTarget, wolf?: string): Promise<HubRead<Set<string>>> {
  const what = "hub receipts";
  const r = await hubCall(hub, `/v1/contributions/receipts${wolfQuery(wolf)}`);
  if ("error" in r || r.status !== 200) return { reason: reasonOf(what, r) };
  const curated = (r.body as { curated?: unknown }).curated;
  return Array.isArray(curated) ? { value: new Set(curated.filter((x): x is string => typeof x === "string")) } : { reason: `${what}: unexpected answer` };
}
export async function readHubReceipts(hub: HubTarget, wolf?: string): Promise<Set<string> | undefined> {
  return (await readHubReceiptsDetailed(hub, wolf)).value;
}

/** Most items per check request (the hub's cap). */
export const CHECK_CHUNK = 2000;

/**
 * Ask the hub what a release would do, for the dry-run review (work-wolfpack-ZBZPAZ9).
 * POST /v1/contributions/check?wolf=<wolf> `{ items: [{ denTopicId, contentHash }] }` → `{ unchanged: string[] }`, sent in chunks of
 * at most CHECK_CHUNK items. An item without a contentHash is never "unchanged". If any chunk fails the whole answer is unknown.
 */
export async function checkHubContributionsDetailed(hub: HubTarget, items: { denTopicId: string; contentHash?: string }[], wolf?: string): Promise<HubRead<Set<string>>> {
  const what = "hub contribution check";
  const out = new Set<string>();
  if (items.length === 0) return { value: out }; // nothing to ask
  for (let i = 0; i < items.length; i += CHECK_CHUNK) {
    const r = await hubCall(hub, `/v1/contributions/check${wolfQuery(wolf)}`, { body: { items: items.slice(i, i + CHECK_CHUNK) } });
    if ("error" in r || r.status !== 200) return { reason: reasonOf(what, r) };
    const unchanged = (r.body as { unchanged?: unknown }).unchanged;
    if (!Array.isArray(unchanged)) return { reason: `${what}: unexpected answer` };
    for (const x of unchanged) if (typeof x === "string") out.add(x);
  }
  return { value: out };
}
export async function checkHubContributions(hub: HubTarget, items: { denTopicId: string; contentHash?: string }[], wolf?: string): Promise<Set<string> | undefined> {
  return (await checkHubContributionsDetailed(hub, items, wolf)).value;
}
