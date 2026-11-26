import { createPresenceApi, liveActivityApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** The hub's presence snapshot for the live graph overlay. */
export function GET(req: Request): Promise<Response> {
	return liveActivityApi().presence(req);
}

/** The owner's "I am viewing X" for the live map: forwarded to the hub with the caller's own bearer; always 204. src/server/pack/presence-api.ts. */
export async function POST(req: Request): Promise<Response> {
	return createPresenceApi().publish(req);
}
