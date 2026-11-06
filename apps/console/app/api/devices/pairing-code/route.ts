import { devicesApi } from "@/src/server";

/**
 * CSRF: minting needs the device's `Authorization: Bearer` (the hub never reads a cookie, and the console's cookie bearer applies to GET/HEAD only,
 * see proxy.ts), so a cross-site page cannot mint a code for the visitor. POST + JSON body keeps it off simple-request form posts.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
	const body = (await req.json().catch(() => ({}))) as { label?: unknown };
	return devicesApi().mint(typeof body.label === "string" ? body.label : undefined);
}
