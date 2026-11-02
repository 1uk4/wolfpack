import { hubHealth } from "@/src/server";

export const dynamic = "force-dynamic";

/** Liveness of the console and its hub link. The only caller of the console's own WOLFPACK_HUB_TOKEN; returns no hub data. */
export async function GET(): Promise<Response> {
	const h = await hubHealth();
	return Response.json({ ok: h.ok, ...(h.reason ? { reason: h.reason } : {}) }, { status: h.status, headers: { "Cache-Control": "no-store" } });
}
