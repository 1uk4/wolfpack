/**
 * Route straightening — pure. While a work node is selected its dependency
 * route detaches from the map's structure and lies on the straight line from
 * the Factory to the selected node: steps in order, evenly spaced; nodes of a
 * parallel step spread perpendicular to the line, centred on it.
 */

import type { LayoutEdge } from "./layout.ts";

export interface RoutePoint {
	x: number;
	y: number;
}

/** Perpendicular distance between neighbours of a parallel step (world units). */
export const ROUTE_LATERAL_SPACING = 56;

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

/**
 * `routeTargetLayout` with user placements: a pinned target moves the line's
 * far anchor; every other pinned node sits exactly where it was dropped
 * (the Factory is never pinned). Re-run per frame while a node is dragged.
 */
export function routeDragLayout(
	rootId: string,
	targetId: string,
	anchors: { root: RoutePoint; target: RoutePoint },
	steps: ReadonlyArray<ReadonlyArray<string>>,
	pins: ReadonlyMap<string, RoutePoint>,
	lateralSpacing: number = ROUTE_LATERAL_SPACING,
): Map<string, RoutePoint> {
	const target = pins.get(targetId) ?? anchors.target;
	const out = routeTargetLayout(rootId, targetId, { root: anchors.root, target }, steps, lateralSpacing);
	for (const [id, p] of pins) if (id !== rootId && out.has(id)) out.set(id, { ...p });
	return out;
}

/** The edges the layout/draw keep while a route is straightened: every edge
 *  touching a route member (other than the Factory) is a hierarchy link that
 *  would pull against the route, so it is dropped. A Factory's links to
 *  non-members stay. */
export function routeFilteredEdges<E extends LayoutEdge>(edges: ReadonlyArray<E>, members: ReadonlySet<string>): E[] {
	const detached = (id: string): boolean => members.has(id) && !id.startsWith(FACTORY_PREFIX);
	return edges.filter((e) => !detached(e.from) && !detached(e.to));
}

/** Ease in-out for the restore/straighten tween. */
export const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
