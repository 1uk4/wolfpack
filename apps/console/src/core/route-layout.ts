/**
 * Route physics — pure. While a work node is selected the SAME force
 * simulation runs on a slightly different link set (the route's members lose
 * their hierarchy links, the route's own edges become springs) plus one weak
 * positional force that leans the route's members towards the straight line
 * from the Factory to the selected node: steps in order, evenly spaced; nodes
 * of a parallel step spread perpendicular to the line, centred on it.
 */

import type { LayoutEdge } from "./layout.ts";

export interface RoutePoint {
	x: number;
	y: number;
}

/** Perpendicular distance between neighbours of a parallel step (world units). */
export const ROUTE_LATERAL_SPACING = 56;

/** Pull of the line force (per unit alpha, as a fraction of the distance to
 *  the target). Weak on purpose: the route leans, it is never snapped. */
export const ROUTE_LINE_STRENGTH = 0.12;

/** Graph id prefix of a Factory node. */
const FACTORY_PREFIX = "fac:";

/**
 * Target positions for the route's nodes. `steps` holds graph ids in step
 * order; the Factory sits at slot 0 and the last step at slot N (the target),
 * so step i lands at t = (i + 1) / N along root -> target. The two anchors
 * (and any node already equal to one) are returned at their own position.
 */
export function routeTargetLayout(
	rootId: string,
	targetId: string,
	anchors: { root: RoutePoint; target: RoutePoint },
	steps: ReadonlyArray<ReadonlyArray<string>>,
	lateralSpacing: number = ROUTE_LATERAL_SPACING,
): Map<string, RoutePoint> {
	const out = new Map<string, RoutePoint>();
	out.set(rootId, { ...anchors.root });
	out.set(targetId, { ...anchors.target });
	const dx = anchors.target.x - anchors.root.x;
	const dy = anchors.target.y - anchors.root.y;
	const len = Math.hypot(dx, dy);
	// Degenerate (coincident anchors): any axis will do, deterministically.
	const ux = len > 1e-9 ? dx / len : 1;
	const uy = len > 1e-9 ? dy / len : 0;
	const px = -uy;
	const py = ux;
	const total = steps.length;
	steps.forEach((step, i) => {
		const t = (i + 1) / total;
		const cx = anchors.root.x + dx * t;
		const cy = anchors.root.y + dy * t;
		const movers = step.filter((id) => id !== rootId && id !== targetId);
		movers.forEach((id, j) => {
			const off = (j - (movers.length - 1) / 2) * lateralSpacing;
			out.set(id, { x: cx + px * off, y: cy + py * off });
		});
	});
	return out;
}

/** The edges the simulation/draw keep while a route is selected: every edge
 *  touching a route member (other than the Factory) is a hierarchy link that
 *  would pull against the route, so it is dropped. A Factory's links to
 *  non-members stay. */
export function routeFilteredEdges<E extends LayoutEdge>(edges: ReadonlyArray<E>, members: ReadonlySet<string>): E[] {
	const detached = (id: string): boolean => members.has(id) && !id.startsWith(FACTORY_PREFIX);
	return edges.filter((e) => !detached(e.from) && !detached(e.to));
}

/** The link set the simulation runs on while a route is selected: the
 *  filtered hierarchy plus the route's own edges (keys `from|to`, as the
 *  route model supplies them) as plain springs. Edges with an unknown
 *  endpoint (`known`) or already present are skipped. */
export function routeLinkSet<E extends LayoutEdge>(
	edges: ReadonlyArray<E>,
	members: ReadonlySet<string>,
	routeEdgeKeys: Iterable<string>,
	known: (id: string) => boolean,
): LayoutEdge[] {
	const out: LayoutEdge[] = routeFilteredEdges(edges, members);
	const seen = new Set(out.map((e) => `${e.from}|${e.to}`));
	for (const key of routeEdgeKeys) {
		const i = key.indexOf("|");
		if (i <= 0 || seen.has(key)) continue;
		const from = key.slice(0, i);
		const to = key.slice(i + 1);
		if (from === to || !known(from) || !known(to)) continue;
		seen.add(key);
		out.push({ from, to });
	}
	return out;
}

/** The dependency springs kept while a route is selected: those between two
 *  route members that are not route edges are dropped (the route's expanded
 *  path already expresses them). Everything else keeps its spring. */
export function routeDepSprings<E extends LayoutEdge>(
	springs: ReadonlyArray<E>,
	members: ReadonlySet<string>,
	routeEdgeKeys: ReadonlySet<string>,
): E[] {
	return springs.filter((e) => !(members.has(e.from) && members.has(e.to) && !routeEdgeKeys.has(`${e.from}|${e.to}`)));
}

interface ForceNode {
	id: string;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
}

/**
 * A d3 force: each route member is pulled (alpha-scaled, like gravity)
 * towards its point on the Factory -> selected-node line. Targets are
 * recomputed every tick from the two ends' CURRENT positions, so dragging
 * either end bends the route. Only route members are touched; the two ends
 * are anchors and receive nothing.
 */
export function routeLineForce(
	layout: { root: string; target: string; steps: ReadonlyArray<ReadonlyArray<string>> },
	strength: number = ROUTE_LINE_STRENGTH,
) {
	let byId = new Map<string, ForceNode>();
	const force = (alpha: number): void => {
		const root = byId.get(layout.root);
		const tgt = byId.get(layout.target);
		if (!root || !tgt) return;
		const targets = routeTargetLayout(
			layout.root,
			layout.target,
			{ root: { x: root.x ?? 0, y: root.y ?? 0 }, target: { x: tgt.x ?? 0, y: tgt.y ?? 0 } },
			layout.steps,
		);
		const k = strength * alpha;
		for (const [id, p] of targets) {
			if (id === layout.root || id === layout.target) continue;
			const n = byId.get(id);
			if (!n) continue;
			n.vx = (n.vx ?? 0) + (p.x - (n.x ?? 0)) * k;
			n.vy = (n.vy ?? 0) + (p.y - (n.y ?? 0)) * k;
		}
	};
	force.initialize = (nodes: ForceNode[]): void => {
		byId = new Map(nodes.map((n) => [n.id, n]));
	};
	return force;
}
