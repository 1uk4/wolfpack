/**
 * THE STATUS PANEL'S TASK GRAPH MODEL (pure, browser-safe, deterministic):
 * which feature the panel graphs, each node's status, the dependency edges
 * and the "x/y shipped" progress. Input is the records the panel already
 * fetches (the bound item and its feature's record with `children`); the
 * layout and drawing live in components/task-graph.tsx.
 */

import type { WorkRecordResponse } from "./kb.ts";

export type TaskStatus = "shipped" | "building" | "ready" | "blocked" | "archived";

export interface TaskNode {
	id: string;
	title: string;
	kind: string;
	stage: string;
	status: TaskStatus;
}

export interface TaskEdge {
	/** The dependency. */
	from: string;
	/** The dependent (`to.dependsOn ∋ from`). */
	to: string;
}

export type TaskGraphModel =
	/** Nothing to graph: no bound item, no parent feature, or the children could not be listed. */
	| { kind: "none" }
	/** The feature is a holding container (Inbox): too large and unrelated to graph, show a count. */
	| { kind: "inbox"; featureId: string; title: string; count: number }
	| {
			kind: "graph";
			featureId: string;
			featureTitle: string;
			nodes: TaskNode[];
			edges: TaskEdge[];
			/** The bound task (glows); null when the bound item is the feature itself. */
			boundId: string | null;
			progress: { shipped: number; total: number };
			/** "7/9 shipped" */
			label: string;
	  };

const isShipped = (stage: string): boolean => stage === "shipped" || stage === "live";

/** Which feature the panel shows for a bound item: a feature shows itself, anything else its parent. Null: none. */
export function featureIdFor(bound: Pick<WorkRecordResponse, "id" | "kind" | "partOf">): string | null {
	return bound.kind === "feature" ? bound.id : (bound.partOf ?? null);
}

/**
 * `bound`: the bound item's record; `feature`: the record of featureIdFor(bound) (it is `bound` itself for a
 * feature). Archived children are hidden (and left out of edges, deps and progress) unless the feature is archived.
 */
export function buildTaskGraph(bound: WorkRecordResponse | null, feature: WorkRecordResponse | null): TaskGraphModel {
	if (!bound || !feature) return { kind: "none" };
	if (feature.container || feature.title === "Inbox") {
		return { kind: "inbox", featureId: feature.id, title: feature.title, count: feature.children?.length ?? 0 };
	}
	if (!feature.children) return { kind: "none" };

	const showArchived = feature.stage === "archived";
	const kids = feature.children.filter((c) => showArchived || c.stage !== "archived");
	const ids = new Set(kids.map((c) => c.id));
	const stageOf = new Map(kids.map((c) => [c.id, c.stage] as const));

	const nodes: TaskNode[] = kids.map((c) => {
		const deps = c.dependsOn.filter((d) => ids.has(d));
		let status: TaskStatus;
		if (c.stage === "archived") status = "archived";
		else if (isShipped(c.stage)) status = "shipped";
		else if (c.stage === "in_build") status = "building";
		else status = deps.every((d) => isShipped(stageOf.get(d) ?? "")) ? "ready" : "blocked";
		return { id: c.id, title: c.title, kind: c.kind, stage: c.stage, status };
	});

	const edges: TaskEdge[] = [];
	for (const c of kids) for (const d of new Set(c.dependsOn)) if (ids.has(d) && d !== c.id) edges.push({ from: d, to: c.id });

	const shipped = nodes.filter((n) => n.status === "shipped").length;
	const boundId = bound.kind !== "feature" && ids.has(bound.id) ? bound.id : null;
	return {
		kind: "graph",
		featureId: feature.id,
		featureTitle: feature.title,
		nodes,
		edges,
		boundId,
		progress: { shipped, total: nodes.length },
		label: `${shipped}/${nodes.length} shipped`,
	};
}
