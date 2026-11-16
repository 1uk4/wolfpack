/**
 * A small in-memory response cache for the heavy read routes (KB graph, work list) (work-wolfpack-WT99MnL).
 *
 * `cachedResponse(req, key, compute, {ttlMs})` keeps `{body, etag, at}` per key AND per credential (the Authorization/Cookie headers are
 * hashed into the entry id, so one device's token-scoped body is never served to another). The etag is a strong sha1 of the body. A request
 * whose If-None-Match equals the etag gets a 304 with no body and no recompute; anything else gets the cached body with
 * `ETag` and `Cache-Control: private, no-cache` (the browser always revalidates, and reuses its copy on a 304).
 * Only 2xx responses are cached. `invalidate(prefix)` drops every entry whose key starts with the prefix. The cache is bounded (oldest dropped).
 */
import { createHash } from "node:crypto";

interface Entry {
	key: string;
	body: string;
	etag: string;
	status: number;
	contentType: string;
	at: number;
}

export interface CacheOptions {
	ttlMs: number;
	/** Default 20. */
	maxEntries?: number;
	now?: () => number;
}

const entries = new Map<string, Entry>();
const sha = (s: string): string => createHash("sha1").update(s).digest("hex");

function respond(req: Request, e: Entry): Response {
	const headers = { ETag: e.etag, "Cache-Control": "private, no-cache" };
	const inm = req.headers.get("if-none-match");
	if (inm && inm.split(",").some((t) => t.trim() === e.etag)) return new Response(null, { status: 304, headers });
	return new Response(e.body, { status: e.status, headers: { ...headers, "content-type": e.contentType } });
}

export async function cachedResponse(req: Request, key: string, compute: () => Promise<Response>, opts: CacheOptions): Promise<Response> {
	const now = opts.now ?? Date.now;
	const id = `${key}\u0000${sha(`${req.headers.get("authorization") ?? ""}\u0000${req.headers.get("cookie") ?? ""}`)}`;
	const hit = entries.get(id);
	if (hit && now() - hit.at < opts.ttlMs) return respond(req, hit);

	const res = await compute();
	if (res.status < 200 || res.status >= 300) return res;
	const body = await res.text();
	const entry: Entry = {
		key,
		body,
		etag: `"${sha(body)}"`,
		status: res.status,
		contentType: res.headers.get("content-type") ?? "application/json",
		at: now(),
	};
	entries.delete(id);
	entries.set(id, entry);
	const max = opts.maxEntries ?? 20;
	while (entries.size > max) entries.delete(entries.keys().next().value as string);
	return respond(req, entry);
}

/** Drop every entry whose key starts with `prefix` (all credentials). */
export function invalidate(prefix: string): void {
	for (const [id, e] of entries) if (e.key.startsWith(prefix)) entries.delete(id);
}
