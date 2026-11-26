import { liveActivityApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** The hub's pack.activity + resync frames for the live graph overlay (src/server/pack/live-activity-api.ts). */
export function GET(req: Request): Promise<Response> {
	return liveActivityApi().stream(req);
}
