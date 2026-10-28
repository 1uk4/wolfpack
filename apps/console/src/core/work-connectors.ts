/**
 * THE WORK VIEW'S GUTTER CONNECTORS (pure): the dependencies among siblings (feature → feature in an initiative, task →
 * task in a feature, loose items in the Inbox) drawn as lanes in a narrow left gutter, one SVG per group. A prerequisite
 * row owns a TRUNK, a vertical line running down from it to its last visible dependent; each dependent gets a branch,
 * an elbow into an arrow at the start of its row. A row with several prerequisites has several trunks whose branches
 * meet at the same arrow (diamonds). Trunks take lanes by greedy interval allocation: a lane is free again once the
 * trunk in it has ended (a trunk may start on the row where the previous one ends), so a chain needs one lane.
 * Rows have a fixed height, so a row's y is its index in the group's visible rows.
 */

import { DEP_COLORS, ROUTE_DONE_COLOR } from "./dep-palette.ts";
import type { WorkRouteView } from "./work-select.ts";
import type { TableRow } from "./work-table.ts";

export const WORK_ROW_H = 32;
export const LANE_W = 7;
export const GUTTER_PAD = 5;
/** Space right of the last lane for the elbow's arrow. */
export const ARROW_W = 8;

export interface ConnectorEdge {
	/** The prerequisite and the dependent (work ids). */
	from: string;
	to: string;
	/** Lane index (0 = leftmost) of the prerequisite's trunk. */
	lane: number;
	/** Indexes into the group's visible rows. */
	fromRow: number;
	toRow: number;
	/** The dependent is done (the graph's done-by-head rule): the lane is muted. */
	done: boolean;
}

export interface GroupConnectors {
	/** The group's visible rows in draw order (the group row is index 0); y = index × WORK_ROW_H. */
	rows: TableRow[];
	lanes: number;
	/** Gutter width in px; 0 when there is nothing to draw. */
	width: number;
	edges: ConnectorEdge[];
}

/** The graph's done-by-head rule: a shipped/live/archived/graduated item, or a feature whose tasks are all done. */
export function rowDone(r: TableRow): boolean {
	if (r.stage === "shipped" || r.stage === "live" || r.stage === "archived" || r.graduated) return true;
	return r.kind === "feature" && r.progress !== null && r.progress.total > 0 && r.progress.shipped === r.progress.total;
}

/** Greedy interval lane allocation over [start, end] row spans: the lane per span and the lane count. */
export function allocateLanes(spans: readonly { start: number; end: number }[]): { lanes: number[]; count: number } {
	const order = spans.map((_, i) => i).sort((a, b) => spans[a]!.start - spans[b]!.start || spans[a]!.end - spans[b]!.end);
	const laneEnd: number[] = [];
	const lanes = new Array<number>(spans.length).fill(0);
	for (const i of order) {
		const { start, end } = spans[i]!;
		let lane = laneEnd.findIndex((e) => e <= start);
		if (lane === -1) lane = laneEnd.length;
		laneEnd[lane] = end;
		lanes[i] = lane;
	}
	return { lanes, count: laneEnd.length };
}

/** The group's connectors for the rows currently visible (`isOpen` says whether a row shows its children). */
export function groupConnectors(group: TableRow, isOpen: (row: TableRow) => boolean): GroupConnectors {
	const rows: TableRow[] = [];
	const siblingSets: TableRow[][] = [];
	const walk = (r: TableRow): void => {
		rows.push(r);
		if (r.children.length === 0 || !isOpen(r)) return;
		siblingSets.push(r.children);
		for (const c of r.children) walk(c);
	};
	walk(group);
	const index = new Map(rows.map((r, i) => [r.id, i] as const));

	const pairs: { from: TableRow; to: TableRow; fromRow: number; toRow: number }[] = [];
	for (const set of siblingSets) {
		const ids = new Set(set.map((r) => r.id));
		for (const to of set) {
			for (const d of to.dependsOn) {
				if (!ids.has(d)) continue;
				const from = set.find((r) => r.id === d)!;
				const fromRow = index.get(from.id)!;
				const toRow = index.get(to.id)!;
				if (fromRow < toRow) pairs.push({ from, to, fromRow, toRow });
			}
		}
	}
	if (pairs.length === 0) return { rows, lanes: 0, width: 0, edges: [] };

	// One trunk per prerequisite row, spanning down to its last dependent.
	const trunkOf = new Map<number, number>();
	const trunks: { start: number; end: number }[] = [];
	for (const p of pairs) {
		let t = trunkOf.get(p.fromRow);
		if (t === undefined) {
			t = trunks.length;
			trunkOf.set(p.fromRow, t);
			trunks.push({ start: p.fromRow, end: p.toRow });
		} else trunks[t]!.end = Math.max(trunks[t]!.end, p.toRow);
	}
	const { lanes, count } = allocateLanes(trunks);
	const edges = pairs.map((p) => ({
		from: p.from.id,
		to: p.to.id,
		lane: lanes[trunkOf.get(p.fromRow)!]!,
		fromRow: p.fromRow,
		toRow: p.toRow,
		done: rowDone(p.to),
	}));
	return { rows, lanes: count, width: GUTTER_PAD * 2 + count * LANE_W + ARROW_W, edges };
}

export const laneKey = (e: Pick<ConnectorEdge, "from" | "to">): string => `${e.from}>${e.to}`;

export type LaneState = "lit" | "done" | "plain";

/**
 * How one lane draws: muted when its dependent is done, lit when it touches the selected row or both of its ends are
 * on the selected route (split view), otherwise the faint dependency colour.
 */
export function laneState(e: Pick<ConnectorEdge, "from" | "to" | "done">, view: WorkRouteView | null): LaneState {
	if (e.done) return "done";
	if (view && (e.from === view.selected || e.to === view.selected || (e.from in view.steps && e.to in view.steps))) return "lit";
	return "plain";
}

export const LANE_COLOR: Record<LaneState, string> = { lit: DEP_COLORS.route, done: ROUTE_DONE_COLOR, plain: DEP_COLORS.faintDep };

/** SVG geometry of one edge: the trunk segment, the elbow into the arrow, the arrowhead. */
export function lanePath(e: ConnectorEdge, lanes: number): { d: string; head: string } {
	const x = GUTTER_PAD + e.lane * LANE_W + LANE_W / 2;
	const ax = GUTTER_PAD + lanes * LANE_W + ARROW_W - 1;
	const y1 = e.fromRow * WORK_ROW_H + WORK_ROW_H / 2 + 6;
	const y2 = e.toRow * WORK_ROW_H + WORK_ROW_H / 2;
	const r = 3;
	return {
		d: `M${x} ${y1}V${y2 - r}Q${x} ${y2} ${x + r} ${y2}H${ax - 4}`,
		head: `M${ax - 5} ${y2 - 3}L${ax} ${y2}L${ax - 5} ${y2 + 3}Z`,
	};
}
