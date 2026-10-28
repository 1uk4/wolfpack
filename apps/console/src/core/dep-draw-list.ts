/**
 * The dependency draw list — pure. Decides WHICH dependency arrows the canvas
 * draws for a camera, visibility and route selection; the renderer only
 * strokes what this returns.
 *
 *   - nothing above the zoom threshold (ratio > maxRatio);
 *   - only edges with both endpoints inside the same Factory region that is
 *     in view (its members' bounding box meets the viewport);
 *   - faint by default; edges of the selected route are bright (and listed
 *     last, so they draw on top); route edges the payload lacks (a feature's
 *     terminal task -> a dependent feature's entry task) are added as bright;
 *   - while a route is selected, a payload dependency between two route
 *     members that is not itself a route edge (e.g. feature -> feature, which
 *     the route expresses through its expanded path) is not drawn.
 */

import { DEP_ARROW_MAX_RATIO } from "./dep-palette.ts";

/** The selected route, as the route model (work-route.ts) supplies it. Ids are
 *  graph node ids; an edge key is `${prerequisiteId}|${dependentId}`. */
export interface DepRouteSelection {
	nodes: ReadonlySet<string>;
	edges: ReadonlySet<string>;
	parallel: ReadonlySet<string>;
	done: ReadonlySet<string>;
	/** The node the card's cursor is on (drawn stronger than the rest of the route). */
	cursor?: string | null;
	/** Straightening input: the route's steps (graph ids, in order) between
	 *  the Factory (`root`) and the selected node (`target`). */
	layout?: { root: string; target: string; steps: ReadonlyArray<ReadonlyArray<string>> };
}

export const edgeKey = (from: string, to: string): string => `${from}|${to}`;

/** A payload dependency that a selected route supersedes: both ends are route
 *  members but the edge is not a route edge. */
export const isRouteShortcut = (
	route: Pick<DepRouteSelection, "nodes" | "edges"> | null | undefined,
	from: string,
	to: string,
): boolean => !!route && route.nodes.has(from) && route.nodes.has(to) && !route.edges.has(edgeKey(from, to));

/** An arrow from a prerequisite (`from`) to its dependent (`to`). */
export interface DepArrow {
	from: string;
	to: string;
	bright: boolean;
}

export interface DepDrawInput {
	/** Dependency edges, prerequisite -> dependent. */
	edges: ReadonlyArray<{ from: string; to: string }>;
	/** Factory regions (member node ids). */
	factories: ReadonlyArray<{ members: ReadonlyArray<string> }>;
	positions: ReadonlyMap<string, { x: number; y: number }>;
	/** World-space viewport. */
	viewport: { minX: number; minY: number; maxX: number; maxY: number };
	/** Camera ratio (kFit / k). */
	ratio: number;
	maxRatio?: number;
	/** Search filter (null = everything visible). */
	visible?: ReadonlySet<string> | null;
	route?: DepRouteSelection | null;
	/** World padding added around each Factory's bounding box. */
	pad?: number;
}

export interface DepDrawList {
	arrows: DepArrow[];
}

export function buildDepDrawList(input: DepDrawInput): DepDrawList {
	const maxRatio = input.maxRatio ?? DEP_ARROW_MAX_RATIO;
	if (!(input.ratio <= maxRatio)) return { arrows: [] };
	const { viewport: vp, positions, visible, route } = input;
	const pad = input.pad ?? 0;

	// Factory regions in view -> member id sets.
	const regions: Set<string>[] = [];
	for (const f of input.factories) {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const id of f.members) {
			const p = positions.get(id);
			if (!p) continue;
			minX = Math.min(minX, p.x);
			maxX = Math.max(maxX, p.x);
			minY = Math.min(minY, p.y);
			maxY = Math.max(maxY, p.y);
		}
		if (minX > maxX) continue;
		if (maxX + pad < vp.minX || minX - pad > vp.maxX || maxY + pad < vp.minY || minY - pad > vp.maxY) continue;
		regions.push(new Set(f.members));
	}
	if (regions.length === 0) return { arrows: [] };

	const seen = new Set<string>();
	const faint: DepArrow[] = [];
	const bright: DepArrow[] = [];
	const consider = (from: string, to: string): void => {
		const key = edgeKey(from, to);
		if (seen.has(key) || from === to) return;
		seen.add(key);
		if (isRouteShortcut(route, from, to)) return;
		if (visible && (!visible.has(from) || !visible.has(to))) return;
		if (!positions.has(from) || !positions.has(to)) return;
		if (!regions.some((r) => r.has(from) && r.has(to))) return;
		if (route?.edges.has(key)) bright.push({ from, to, bright: true });
		else faint.push({ from, to, bright: false });
	};
	for (const e of input.edges) consider(e.from, e.to);
	if (route) {
		for (const key of route.edges) {
			const i = key.indexOf("|");
			if (i > 0) consider(key.slice(0, i), key.slice(i + 1));
		}
	}
	return { arrows: [...faint, ...bright] };
}
