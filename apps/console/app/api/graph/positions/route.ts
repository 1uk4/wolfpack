/**
 * /api/graph/positions — the KB graph's stored node positions (the
 * console's own data dir; the KB is never written).
 *
 *   GET → 200 {positions}: the whole stored map, nodeId → {x, y}.
 *   PUT → 200 {positions}: the live-physics commit. The body (a map of
 *         nodeId → {x, y}) is sanitized and merged over the stored map;
 *         the response is the batch that was applied (empty = nothing
 *         valid, nothing written).
 */
import { commitGraphPositions, graphPositions } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ positions: graphPositions() });
}

export async function PUT(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}
	return Response.json({ positions: commitGraphPositions(body) });
}
