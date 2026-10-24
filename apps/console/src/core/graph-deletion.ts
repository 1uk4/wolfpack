/**
 * Graph node deletion — a destructive operation on the append-only graph
 * ledgers (the inert graph view's delete-node flow).
 *
 * PURE code over the storage ports (core/ports.ts), no LLM judgment
 * anywhere, deterministic and idempotent.
 *
 * CHAINS-PRIMARY: the stored truth is propositions + reasoning chains;
 * edges are a derived view. Deletion therefore operates on CHAIN LINES —
 * the derived view follows on the next read, never rewritten here.
 */

import type { GraphNode } from "./contracts.ts";
import type { GraphStore } from "./ports.ts";

// ─── single-node deletion (node interlude, owner-locked full-death) ───────────

/**
 * FULL DEATH for one node, by id (owner ruling 2026-09-23): the user
 * pointing at the node IS the intent — references from other sessions do
 * NOT preserve it. The remedy for undeletable nodes (preserve-graph
 * orphans from session deletion; notes-import nodes with no chat behind
 * them): deletes a NODE and takes its every trace —
 *
 *   - every line of the node (create + link lines)
 *   - every CHAIN referencing it (as premise or conclusion), whatever
 *     session asserted it — a chain with a dead member is not a chain
 *   - its resting position (and every dead chain's)
 *
 * An ARGUMENT deletion is the same call with an arg_-prefixed id (owner,
 * 2026-09-30: the chain table's fenced delete kills chains): the "node"
 * is the derived implication node whose id IS the chain's id.
 *
 * The blast radius is exactly the rows naming the id: other nodes'
 * provenance, aliases, and sessions are untouched (full death is
 * NODE-scoped, not session-scoped), and the source records of notes
 * imports stay (the import's bookkeeping; deleting one proposition is not
 * deleting the file). Derived data needs no pruning: the birth partition
 * derives on read (the cluster shrinks below MIN_CLUSTER_SIZE and stops
 * rendering — fine), and no other consumer indexes nodes by id across
 * ledgers.
 *
 * Synchronous, one rewriteLedgers call, no awaits (the same atomicity
 * argument as the chat cascade); idempotent in the wave-6 sense — a
 * second run finds no lines and changes nothing.
 */
export interface NodeDeletionStats {
	/** Chain assertion LINES removed (every chain referencing the node). */
	chainsRemoved: number;
}

function nodeLinesOf(graphStore: GraphStore, nodeId: string): GraphNode[] {
	return graphStore.readNodes().filter((line) => line.id === nodeId);
}

/**
 * Full-death one node (or one argument, by its arg_ id). Returns null
 * when no such node/chain exists (the orchestration maps that to 404);
 * rewrites only the ledgers that changed (unchanged files keep their
 * mtimes — the version stamp moves only when something really did).
 */
export function deleteNodeTraces(graphStore: GraphStore, nodeId: string): NodeDeletionStats | null {
	const chainLines = graphStore.readChains();

	// The argument branch: an arg_ id names a CHAIN, not a proposition —
	// its lines die, and that is the whole death (the member propositions
	// survive: deleting an argument spares its premises/conclusion).
	if (nodeId.startsWith("arg_")) {
		const outChains = chainLines.filter((line) => line.id !== nodeId);
		if (outChains.length === chainLines.length) return null; // unknown argument
		graphStore.rewriteLedgers({ chains: outChains });
		const positions = graphStore.readPositions();
		if (positions[nodeId] !== undefined) {
			const { [nodeId]: _dead, ...rest } = positions;
			graphStore.writePositions(rest);
		}
		return { chainsRemoved: chainLines.length - outChains.length };
	}

	const nodeLines = nodeLinesOf(graphStore, nodeId);
	if (nodeLines.length === 0) return null;

	const outChains = chainLines.filter(
		(line) => line.conclusion !== nodeId && !line.premises.includes(nodeId),
	);

	// Only the touched ledgers: the node's own lines always die (its file
	// must move), everything else rewrites only when rows actually drop.
	const outNodes = graphStore.readNodes().filter((line) => line.id !== nodeId);
	graphStore.rewriteLedgers({
		nodes: outNodes,
		...(outChains.length !== chainLines.length ? { chains: outChains } : {}),
	});

	// The resting positions die with the node and every dead chain.
	const deadChainIds = new Set(chainLines.filter((line) => !outChains.includes(line)).map((line) => line.id));
	const positions = graphStore.readPositions();
	const prunedPositions = Object.fromEntries(
		Object.entries(positions).filter(([id]) => id !== nodeId && !deadChainIds.has(id)),
	);
	if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
		graphStore.writePositions(prunedPositions);
	}

	return {
		chainsRemoved: chainLines.length - outChains.length,
	};
}
