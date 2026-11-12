import { createUpdatesHandler } from "@/src/server/pack/updates-api";

export const dynamic = "force-dynamic";

const updates = createUpdatesHandler();

/** Pack update notices: running vs latest stable version per component (src/server/pack/updates-api.ts). Versions and public release links only. `?refresh=1` re-reads the release manifest now instead of using its 10-minute cache. */
export async function GET(req: Request): Promise<Response> {
	const refresh = new URL(req.url).searchParams.get("refresh") === "1";
	return Response.json(await updates({ refresh }), { headers: { "Cache-Control": "no-store" } });
}
