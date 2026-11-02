import { cachedHubHealth } from "@/src/server";

export const dynamic = "force-dynamic";

const health = cachedHubHealth();

/** Liveness of the console and its hub link. The only user of the console's own WOLFPACK_HUB_TOKEN. Answers only {ok} + the status; the reason is logged server-side. Cached ~5s. */
export async function GET(): Promise<Response> {
	const h = await health();
	return Response.json({ ok: h.ok }, { status: h.status, headers: { "Cache-Control": "no-store" } });
}
