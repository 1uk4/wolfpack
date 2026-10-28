/**
 * THE FEATURE PROGRESS PANEL'S MODEL (pure, browser-safe, deterministic): the pinned panel of a thread bound to a
 * feature (or to a task of one). Input is live Work API data (the bound item's record and its feature's record with
 * `children`), never anything the model said. Statuses come from buildTaskGraph; the layering of the strip (columns =
 * dependency steps) from computeWorkRoute, the same route model the graph page walks.
 */

import type { WorkRecordResponse } from "./kb.ts";
import { buildTaskGraph, type TaskStatus } from "./task-graph.ts";
import { computeWorkRoute, type WorkNode } from "./work-route.ts";

export interface ProgressTask {
	id: string;
	title: string;
	kind: string;
	stage: string;
	status: TaskStatus;
	shipped: boolean;
	/** An unshipped prerequisite (not shown on shipped tasks). */
	blocked: boolean;
	/** The task the thread is bound to. */
	bound: boolean;
	/** 1-based position in the list (execution order: layer, then row); the strip's node label. */
	index: number;
	layer: number;
	row: number;
	dependsOn: string[];
}

export type FeatureProgress =
	| { kind: "none" }
	| {
			kind: "progress";
			featureId: string;
			title: string;
			shipped: number;
			total: number;
			/** "4/9 shipped" */
			label: string;
			/** The list, in execution order. */
			tasks: ProgressTask[];
			edges: { from: string; to: string }[];
			layers: number;
			/** The most nodes in one layer. */
			rows: number;
			/** The thread is bound to the feature itself, not (yet) to one of its tasks. */
			boundIsFeature: boolean;
	  };

export function buildFeatureProgress(bound: WorkRecordResponse | null, feature: WorkRecordResponse | null): FeatureProgress {
	const g = buildTaskGraph(bound, feature);
	if (g.kind !== "graph") return { kind: "none" };
	const nodes: WorkNode[] = [
		{ id: g.featureId, kind: "feature", stage: feature?.stage ?? "" },
		...g.nodes.map((n) => ({ id: n.id, kind: "task", stage: n.stage, parent: g.featureId, dependsOn: (feature?.children ?? []).find((c) => c.id === n.id)?.dependsOn ?? [] })),
	];
	const route = computeWorkRoute(nodes, g.featureId, { parentMode: "none" });
	const layerOf = new Map<string, number>();
	const rowOf = new Map<string, number>();
	let rows = 0;
	for (const s of route.steps) {
		const ids = s.nodes.filter((id) => id !== g.featureId);
		ids.forEach((id, r) => {
			layerOf.set(id, s.index);
			rowOf.set(id, r);
		});
		rows = Math.max(rows, ids.length);
	}
	// Steps can be empty after dropping the feature node: renumber to the used layers.
	const used = [...new Set(layerOf.values())].sort((a, b) => a - b);
	const compact = new Map(used.map((l, i) => [l, i] as const));
	const edgeSet = route.edges.filter((e) => !e.root && layerOf.has(e.from) && layerOf.has(e.to)).map((e) => ({ from: e.from, to: e.to }));
	const kidsDeps = new Map((feature?.children ?? []).map((c) => [c.id, c.dependsOn] as const));
	const ordered = g.nodes
		.map((n) => ({ n, layer: compact.get(layerOf.get(n.id) ?? 0) ?? 0, row: rowOf.get(n.id) ?? 0 }))
		.sort((a, b) => a.layer - b.layer || a.row - b.row || (a.n.id < b.n.id ? -1 : 1));
	const tasks: ProgressTask[] = ordered.map(({ n, layer, row }, i) => ({
		id: n.id,
		title: n.title,
		kind: n.kind,
		stage: n.stage,
		status: n.status,
		shipped: n.status === "shipped",
		blocked: n.status !== "shipped" && n.status !== "archived" && !!route.blocked[n.id],
		bound: n.id === g.boundId,
		index: i + 1,
		layer,
		row,
		dependsOn: kidsDeps.get(n.id) ?? [],
	}));
	return {
		kind: "progress",
		featureId: g.featureId,
		title: g.featureTitle,
		shipped: g.progress.shipped,
		total: g.progress.total,
		label: g.label,
		tasks,
		edges: edgeSet,
		layers: used.length,
		rows,
		boundIsFeature: g.boundId === null,
	};
}

// ---------------------------------------------------------------- strip geometry

export const STRIP_COL_W = 56;
export const STRIP_ROW_H = 30;
export const STRIP_NODE_W = 28;
export const STRIP_NODE_H = 20;

export interface StripNode {
	id: string;
	/** Centre. */
	x: number;
	y: number;
}

export interface StripLayout {
	width: number;
	height: number;
	nodes: StripNode[];
	/** Left to right: each edge runs from the right side of `from` to the left side of `to`. */
	edges: { from: string; to: string; d: string }[];
}

/** The compact LR strip: one column per dependency step, nodes of a column stacked and centred vertically. */
export function layoutStrip(p: Extract<FeatureProgress, { kind: "progress" }>): StripLayout {
	const width = Math.max(1, p.layers) * STRIP_COL_W;
	const height = Math.max(1, p.rows) * STRIP_ROW_H;
	const perLayer = new Map<number, number>();
	for (const t of p.tasks) perLayer.set(t.layer, (perLayer.get(t.layer) ?? 0) + 1);
	const nodes: StripNode[] = p.tasks.map((t) => {
		const count = perLayer.get(t.layer) ?? 1;
		return { id: t.id, x: t.layer * STRIP_COL_W + STRIP_COL_W / 2, y: (height - count * STRIP_ROW_H) / 2 + t.row * STRIP_ROW_H + STRIP_ROW_H / 2 };
	});
	const at = new Map(nodes.map((n) => [n.id, n] as const));
	const edges = p.edges.flatMap((e) => {
		const a = at.get(e.from);
		const b = at.get(e.to);
		if (!a || !b) return [];
		const x1 = a.x + STRIP_NODE_W / 2;
		const x2 = b.x - STRIP_NODE_W / 2;
		const mx = (x1 + x2) / 2;
		return [{ from: e.from, to: e.to, d: `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}` }];
	});
	return { width, height, nodes, edges };
}
