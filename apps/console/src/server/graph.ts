import * as fs from "node:fs";
import { LEDGER_FILES, POSITIONS_FILE } from "../../config.ts";
import type { GraphSnapshot } from "../core/contracts.ts";
import { graphSnapshot } from "../core/graph.ts";
import { deleteNodeTraces, type NodeDeletionStats } from "../core/graph-deletion.ts";
import { stores } from "./stores.ts";

/**
 * Server-side graph entry for the graph view (GET /api/graph). A PURE READ
 * of whatever the ledgers hold — the graph is inert today (nothing in the
 * console writes it).
 */
export function graphView(): GraphSnapshot {
	return graphSnapshot(stores);
}

/** The graph's version stamp: the max mtime across every graph data file —
 * ledgers, positions. Moves on ANY graph write (append, settle, or a
 * deletion's atomic rewrite), never moves on reads, and needs no
 * bookkeeping of its own: the fs IS the counter. Consumers poll it (the
 * activity feed carries it; the node-delete response returns it) to know
 * clusters/layout must refetch. */
export function graphRevision(): number {
	let revision = 0;
	for (const file of [
		LEDGER_FILES.nodes,
		LEDGER_FILES.chains,
		POSITIONS_FILE,
	]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	return revision;
}

// ─── single-node deletion (node interlude, owner-locked full-death) ──────────

/** What deleteGraphNode did — the route maps it straight to HTTP. */
export type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: number };

/**
 * Delete one node by id — FULL DEATH (core/graph-deletion.ts for the
 * ledger semantics). Synchronous: nothing can interleave between the
 * lookup and the ledger rewrite (the event loop never yields inside).
 */
export function deleteGraphNode(nodeId: string): NodeDeleteOutcome {
	const stats = deleteNodeTraces(stores.graphStore, nodeId);
	if (stats === null) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, stats, graphRevision: graphRevision() };
}
