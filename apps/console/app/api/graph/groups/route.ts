/**
 * GET/PUT /api/graph/groups — the graph's visual domain groups (work-wolfpack-FnzgC6g), stored in the console's own data dir
 * (data/graph/groups.json), so every device on this console sees the same bubbles and nothing depends on a remote hub.
 *
 *   GET → 200 { groups: [...] } (empty list when none saved)
 *   PUT → body { groups: [...] } replaces the list; 200 the sanitized list actually stored (one group per domain)
 */
import { readGraphGroups, writeGraphGroups } from "@/src/server";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export const GET = () => Response.json(readGraphGroups(), { headers: NO_STORE });

export async function PUT(req: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}
	return Response.json(writeGraphGroups(body), { headers: NO_STORE });
}
