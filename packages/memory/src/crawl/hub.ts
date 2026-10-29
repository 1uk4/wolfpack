/**
 * Release a crawl to a hub (hubd) instead of the local KB_OPS inbox.
 *
 * Config (same knobs as the console): `WOLFPACK_HUB_URL` (the hubd base URL) and `WOLFPACK_HUB_KEY` (its X-API-Key). Unset URL = the
 * file-write path (`emitCrawl`) is used unchanged.
 *
 * The contributions are built by the same `emitCrawl` (same dedup, same bodies) into a throwaway staging ops dir and then POSTed to
 * `/v1/contributions` with the wolf actor header. The wolf's `emitted.json` dedup is only kept when every post succeeded; on a failure
 * it is restored, so a retry re-sends (the hub is idempotent on topic + content hash).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { emitCrawl, type EmitCrawlOptions, type EmitCrawlResult } from "./emit.js";

export interface HubTarget {
  baseUrl: string;
  apiKey?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/** The hub configured in `env` (WOLFPACK_HUB_URL / WOLFPACK_HUB_KEY), or undefined. */
export function hubTargetFromEnv(env: Record<string, string | undefined> = process.env): HubTarget | undefined {
  const baseUrl = env.WOLFPACK_HUB_URL?.trim();
  return baseUrl ? { baseUrl, apiKey: env.WOLFPACK_HUB_KEY?.trim() || undefined } : undefined;
}

/** POST one contribution as the wolf. Throws with the hub's error message on a non-2xx. */
export async function postContribution(hub: HubTarget, wolf: string, contribution: object): Promise<{ id: string; duplicate: boolean }> {
  const res = await (hub.fetch ?? fetch)(`${hub.baseUrl.replace(/\/+$/, "")}/v1/contributions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Wolfpack-Actor": JSON.stringify({ id: wolf, kind: "wolf" }),
      ...(hub.apiKey ? { "X-API-Key": hub.apiKey } : {}),
    },
    body: JSON.stringify(contribution),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; duplicate?: boolean; message?: string };
  if (!res.ok) throw new Error(`hub rejected the contribution (${res.status}): ${body.message ?? "no detail"}`);
  return { id: String(body.id), duplicate: !!body.duplicate };
}

/** Like `emitCrawl` (real emit), but delivers to the hub. `dest` of the result is the hub URL. */
export async function emitCrawlToHub(runDir: string, hub: HubTarget, opts: Omit<EmitCrawlOptions, "dryRun"> = {}): Promise<EmitCrawlResult> {
  const wolf = opts.wolf ?? process.env.WOLF_NAME ?? "scribe";
  const denLocal = opts.roots?.denLocal ?? join(process.env.WOLF_DEN ?? join(homedir(), "wolves", "den"), "kb");
  const emittedPath = join(denLocal, "emitted.json");
  const before = existsSync(emittedPath) ? readFileSync(emittedPath, "utf-8") : undefined;
  const staging = mkdtempSync(join(tmpdir(), "crawl-hub-"));
  try {
    const r = emitCrawl(runDir, { ...opts, wolf, dryRun: false, quiet: true, roots: { ...opts.roots, opsRoot: staging, denLocal } });
    try {
      for (const c of r.delta) await postContribution(hub, wolf, c);
    } catch (e) {
      if (before !== undefined) writeFileSync(emittedPath, before);
      else rmSync(emittedPath, { force: true });
      throw e;
    }
    const dest = `${hub.baseUrl.replace(/\/+$/, "")}/v1/contributions`;
    if (!opts.quiet) console.log(`\n${r.emitted} contribution(s) emitted → ${dest}`);
    return { ...r, dest };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
