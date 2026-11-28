import { cachedResponse, memoryApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** Graph cache lifetime: no KB-change event reaches the console process (the hub bridge is per SSE connection), so a short TTL bounds staleness (the hub cache already refreshes on every work write). */
const GRAPH_TTL_MS = 15_000;

/** The KB graph; the server picks the source (relay: the hub's own KB copy, token-scoped; local: a KB wolf). Cached with an ETag (work-wolfpack-WT99MnL). */
export async function GET(req: Request): Promise<Response> {
	const params = new URL(req.url).searchParams;
	return cachedResponse(req, `graph?${params.toString()}`, () => memoryApi().kbGraphAuto(params), { ttlMs: GRAPH_TTL_MS });
}
