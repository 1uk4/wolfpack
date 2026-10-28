/**
 * THE WORK VIEW'S SELECTION MODEL (pure): what the split-view table needs of the graph's selected route. The graph owns
 * the selection (route, physics, pane); it publishes a `WorkRouteView` distilled from the very same `computeWorkRoute`
 * result, and the table lights its rows from it: step numbers (parallel steps share one), the cursor row, collapsed
 * done features as one row with "+N". Also the left column's remembered, pane-clamped width.
 */

import { clampPaneWidth } from "./graph-pane.ts";
import type { WorkRoute } from "./work-route.ts";
import type { TableRow } from "./work-table.ts";

export const WORK_COL_WIDTH_KEY = "wolfpack:work-view-col-width";
export const WORK_COL_DEFAULT_WIDTH = 520;

/** The stored column width (a string off localStorage) → a usable width; absent/corrupt → the default. Clamped like the pane. */
export function parseWorkColWidth(raw: string | null | undefined, viewport?: number): number {
	if (raw == null || raw.trim() === "") return clampPaneWidth(WORK_COL_DEFAULT_WIDTH, viewport);
	const n = Number(raw);
	return Number.isFinite(n) ? clampPaneWidth(n, viewport) : clampPaneWidth(WORK_COL_DEFAULT_WIDTH, viewport);
}

export interface WorkRouteView {
	/** The raw work id the graph has selected. */
	selected: string;
	/** The pane's cursor node (raw id), or null. */
	cursor: string | null;
	/** Route node → its 1-based step number (the pane's "Step N of M") and whether the step is parallel. */
	steps: Record<string, { step: number; parallel: boolean }>;
	/** Collapsed done feature → how many tasks it stands in for ("+N"). */
	collapsed: Record<string, number>;
}

/** The selection as the table needs it; `route` null (a selection with no route) lights just the selected row. */
export function workRouteView(route: WorkRoute | null, selected: string, cursor: string | null): WorkRouteView {
	const steps: WorkRouteView["steps"] = {};
	const collapsed: WorkRouteView["collapsed"] = {};
	if (route) {
		for (const s of route.steps) for (const n of s.nodes) steps[n] = { step: s.index + 1, parallel: s.parallel };
		for (const [f, tasks] of Object.entries(route.collapsed)) collapsed[f] = tasks.length;
	}
	return { selected, cursor, steps, collapsed };
}

export type RowRoute =
	| { mode: "none"; selected: false; cursor: false }
	| { mode: "on" | "off"; selected: boolean; cursor: boolean; step: number | null; parallel: boolean };

/** How one row draws against the selection. Rows without a work id (the "No initiative" group) are never dimmed. */
export function rowRouteState(view: WorkRouteView | null, id: string): RowRoute {
	if (!view || !id) return { mode: "none", selected: false, cursor: false };
	const hit = view.steps[id];
	const selected = id === view.selected;
	const cursor = id === (view.cursor ?? view.selected);
	if (hit) return { mode: "on", selected, cursor, step: hit.step, parallel: hit.parallel };
	// The selection with no step of its own (no route) still lights; a collapsed feature is a route stand-in.
	if (selected || id in view.collapsed) return { mode: "on", selected, cursor, step: null, parallel: false };
	// With no route at all (just the selected row), nothing else dims.
	return Object.keys(view.steps).length === 0 ? { mode: "none", selected: false, cursor: false } : { mode: "off", selected: false, cursor: false, step: null, parallel: false };
}

/** Keys of the rows with a descendant whose id is in `ids` (these open so the lit rows are visible). */
export function ancestorKeys(groups: readonly TableRow[], ids: ReadonlySet<string>): string[] {
	const out: string[] = [];
	const walk = (r: TableRow): boolean => {
		let hit = r.id !== "" && ids.has(r.id);
		for (const c of r.children) if (walk(c)) {
			hit = true;
			out.push(r.key);
		}
		return hit;
	};
	for (const g of groups) walk(g);
	return [...new Set(out)];
}
