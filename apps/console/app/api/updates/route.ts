import { createUpdatesHandler } from "@/src/server/pack/updates-api";

export const dynamic = "force-dynamic";

const updates = createUpdatesHandler();

/** Pack update notices: running vs latest stable version per component (src/server/pack/updates-api.ts). Versions and public release links only. */
export async function GET(): Promise<Response> {
	return Response.json(await updates(), { headers: { "Cache-Control": "no-store" } });
}
