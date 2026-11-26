import { createPresenceApi } from "@/src/server/pack/presence-api";

export const dynamic = "force-dynamic";

/** The owner's "I am viewing X" for the live map: forwarded to the hub with the caller's own bearer; always 204. src/server/pack/presence-api.ts. */
export async function POST(req: Request): Promise<Response> {
	return createPresenceApi().publish(req);
}
