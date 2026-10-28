/**
 * THE PINNED FEATURE GRAPH'S MODEL (pure, browser-safe, deterministic): the graph pinned at the top of a thread bound to
 * a feature (or to one of its tasks). Input is live Work API data (the bound item's record and its feature's record with
 * `children`), never anything the model said. Tasks become show_graph nodes, `dependsOn` links become edges, and the
 * status follows buildTaskGraph (GRAPH_STATUS_OF), so the pinned panel and the chat card draw the same thing.
 */

import type { GraphData } from "@wolfpack/protocol/objects";
import type { WorkRecordResponse } from "./kb.ts";
import { buildTaskGraph, GRAPH_STATUS_OF } from "./task-graph.ts";

export type FeatureGraph =
	| { kind: "none" }
	| {
			kind: "graph";
			featureId: string;
			title: string;
			shipped: number;
			total: number;
			/** "4/9 done" */
			label: string;
			/** The show_graph data: node id = work id, `from` depends on `to`. */
			graph: GraphData;
			/** The task the thread is bound to (highlighted); null when it is bound to the feature itself. */
			boundId: string | null;
	  };

export function buildFeatureGraph(bound: WorkRecordResponse | null, feature: WorkRecordResponse | null): FeatureGraph {
	const g = buildTaskGraph(bound, feature);
	if (g.kind !== "graph") return { kind: "none" };
	return {
		kind: "graph",
		featureId: g.featureId,
		title: g.featureTitle,
		shipped: g.progress.shipped,
		total: g.progress.total,
		label: `${g.progress.shipped}/${g.progress.total} done`,
		graph: {
			nodes: g.nodes.map((n) => ({ id: n.id, label: n.title, kind: n.kind, status: GRAPH_STATUS_OF[n.status], detail: n.stage })),
			edges: g.edges.map((e) => ({ from: e.to, to: e.from })),
		},
		boundId: g.boundId,
	};
}

/** The one-line strip of the folded panel. */
export const featureStrip = (g: Extract<FeatureGraph, { kind: "graph" }>): string => `${g.title} · ${g.label}`;

/** A work item id (`work-<domain>-<7 chars>`, the Work API's format). */
export const isWorkItemId = (id: string): boolean => /^work-[a-z0-9-]+-[0-9A-Za-z]{7}$/.test(id);

/** A memory event about a work item (a Record written, an observation tagged to it): the item's stage or tasks may have moved with it. */
export function isWorkEvent(e: { type?: unknown; target?: unknown }): boolean {
	if (e.type !== "record_written" && e.type !== "observation_captured") return false;
	return (e.target as { kind?: unknown } | undefined)?.kind === "work";
}
