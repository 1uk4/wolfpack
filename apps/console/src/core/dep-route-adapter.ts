/**
 * Graph payload ↔ route model. The route model (work-route.ts) speaks raw work
 * ids; the canvas speaks graph ids (`work:<id>`, `fac:<domain>`). This maps
 * between them: payload → WorkNode[], a route + cursor → DepRouteSelection,
 * and a feature node → the task-graph overlay's model.
 */

import type { DepRouteSelection } from "./dep-draw-list.ts";
import type { KbGraph } from "./kb.ts";
import { buildTaskGraph, type TaskGraphModel } from "./task-graph.ts";
import { computeWorkRoute, type RouteCursor, type WorkNode, type WorkRoute } from "./work-route.ts";

const WORK = "work:";
export const rawWorkId = (graphId: string): string | null =>
	graphId.startsWith(WORK) && graphId.length > WORK.length ? graphId.slice(WORK.length) : null;

/** Work nodes of the payload (kind, stage, parent from partOf, dependsOn). */
export function workNodesFromGraph(graph: Pick<KbGraph, "nodes" | "edges">): WorkNode[] {
	const nodes = new Map<string, WorkNode>();
	for (const n of graph.nodes) {
		const id = n.kind === "work" ? rawWorkId(n.id) : null;
		if (id && !nodes.has(id)) nodes.set(id, { id, kind: n.workKind ?? "task", stage: n.stage ?? "plan", parent: null, dependsOn: [] });
	}
	for (const e of graph.edges) {
		const s = rawWorkId(e.source);
		const t = rawWorkId(e.target);
		const node = s ? nodes.get(s) : undefined;
		if (!node || !t || !nodes.has(t)) continue;
		if (e.kind === "partOf" && !node.parent) node.parent = t;
		else if (e.kind === "dependsOn" && !node.dependsOn!.includes(t)) (node.dependsOn as string[]).push(t);
	}
	return [...nodes.values()];
}

/** The route for a selected graph node, or null when it has none (not a
 *  work node, an initiative, or the Factory itself: the Factory selects no
 *  route). */
export function routeForNode(graph: KbGraph, graphId: string): WorkRoute | null {
	const id = rawWorkId(graphId);
	const node = graph.nodes.find((n) => n.id === graphId);
	if (!id || node?.kind !== "work" || node.workKind === "initiative") return null;
	const route = computeWorkRoute(workNodesFromGraph(graph), id);
	return route.steps.length > 0 ? route : null;
}

/** The raw route id as a graph id (the root → the Factory of `domain`). */
export const toGraphId = (route: WorkRoute, raw: string, domain: string | undefined): string =>
	raw === route.root ? `fac:${domain ?? ""}` : `${WORK}${raw}`;

/** Route + cursor → what the canvas draws. */
export function toRouteSelection(route: WorkRoute, cursor: RouteCursor | null, domain: string | undefined): DepRouteSelection {
	const gid = (raw: string) => toGraphId(route, raw, domain);
	const nodes = new Set<string>([gid(route.root)]);
	const parallel = new Set<string>();
	const done = new Set<string>();
	for (const step of route.steps) {
		for (const n of step.nodes) {
			nodes.add(gid(n));
			if (step.parallel) parallel.add(gid(n));
			if (route.done[n]) done.add(gid(n));
		}
	}
	const edges = new Set(route.edges.map((e) => `${gid(e.from)}|${gid(e.to)}`));
	return { nodes, edges, parallel, done, cursor: cursor?.node ? gid(cursor.node) : null };
}

/** A feature node's task-graph overlay model, built from the payload alone
 *  (children = work partOf the feature, deps among them), through the same
 *  buildTaskGraph the work page uses. Null when it isn't a feature with tasks. */
export function featureTaskModel(graph: KbGraph, graphId: string): Extract<TaskGraphModel, { kind: "graph" }> | null {
	const id = rawWorkId(graphId);
	const feature = graph.nodes.find((n) => n.id === graphId);
	if (!id || feature?.kind !== "work" || feature.workKind !== "feature") return null;
	const work = workNodesFromGraph(graph);
	const titles = new Map(graph.nodes.map((n) => [n.id, n.label] as const));
	const children = work
		.filter((w) => w.parent === id)
		.map((w) => ({ id: w.id, kind: w.kind, stage: w.stage, title: titles.get(`${WORK}${w.id}`) ?? w.id, dependsOn: [...(w.dependsOn ?? [])] }));
	const record = { id, kind: "feature", title: feature.label, stage: feature.stage ?? "plan", dependsOn: [], children } as unknown as Parameters<typeof buildTaskGraph>[0];
	const model = buildTaskGraph(record, record);
	return model.kind === "graph" ? model : null;
}
