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

/** A full 20k-node map is ~1.5MB; anything past this is not ours. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function PUT(request: Request) {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		return Response.json({ error: "body too large" }, { status: 413 });
	}
	let body: unknown;
	try {
		const text = await request.text();
		if (text.length > MAX_BODY_BYTES) return Response.json({ error: "body too large" }, { status: 413 });
		body = JSON.parse(text);
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}
	return Response.json({ positions: commitGraphPositions(body) });
}
