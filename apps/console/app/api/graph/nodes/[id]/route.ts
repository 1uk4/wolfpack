import { deleteGraphNode } from "@/src/server";

/**
 * DELETE /api/graph/nodes/[id] — single-node deletion, FULL DEATH: the
 * node's every line, every chain touching it, and its position die in one
 * atomic ledger rewrite (core/graph-deletion.ts deleteNodeTraces); derived
 * data (birth partition, clusters) self-heals on read. The response carries
 * what was removed plus the new graphRevision (the refetch signal).
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const outcome = deleteGraphNode(id);
	if (!outcome.ok) {
		return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	}
	return Response.json({ stats: outcome.stats, graphRevision: outcome.graphRevision });
}