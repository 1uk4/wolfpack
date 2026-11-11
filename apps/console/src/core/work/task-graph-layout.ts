/**
 * THE TASK GRAPH'S PLACEMENT (pure, deterministic, DOM-free): every connected
 * component is laid out top-to-bottom by dagre on its own, then the components
 * are packed: dependency chains first (largest first), stacked; the independent
 * single tasks after them in a grid wrapped to the available width. Node sizes
 * are fixed by the caller's width and an estimated title height, so the
 * rendered cards and the layout agree exactly.
 */

import { graphlib } from "dagre-d3-es";
import { layout as dagreLayout } from "dagre-d3-es/src/dagre/index.js";
import type { TaskEdge, TaskNode, TaskStatus } from "./task-graph.ts";

export interface TaskLayoutOptions {
	/** Card width in px. */
	nodeWidth: number;
	/** Width the packed singles may fill (they wrap into columns); chains may exceed it. */
	maxWidth: number;
	/** Horizontal gap between cards. Default 24. */
	gapX?: number;
	/** Vertical gap between cards / between ranks. Default 40. */
	gapY?: number;
}

export interface PlacedTask {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface TaskLayout {
	nodes: PlacedTask[];
	width: number;
	height: number;
}

/** Display order: in-build first, then ready, blocked, shipped, archived. */
const STATUS_RANK: Record<TaskStatus, number> = { building: 0, ready: 1, blocked: 2, shipped: 3, archived: 4 };

export const compareTasks = (a: Pick<TaskNode, "id" | "status">, b: Pick<TaskNode, "id" | "status">): number =>
	STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const TITLE_LINE_H = 18;
const MAX_TITLE_LINES = 3;
/** Card chrome: padding (12 top + 12 bottom) + the status row (20) + its gap (6). */
const CARD_CHROME_H = 50;

/** Card height for a title at a card width (the title is clamped to 3 lines); a character-width estimate for 13px sans. */
export function taskNodeHeight(title: string, nodeWidth: number): number {
	const perLine = Math.max(8, Math.floor((nodeWidth - 24) / 6.6));
	let lines = 1;
	let used = 0;
	for (const word of title.trim().split(/\s+/)) {
		const len = Math.min(word.length, perLine);
		if (used === 0) used = len;
		else if (used + 1 + len <= perLine) used += 1 + len;
		else {
			lines++;
			used = len;
		}
		if (word.length > perLine) lines += Math.floor((word.length - 1) / perLine);
	}
	return CARD_CHROME_H + Math.min(lines, MAX_TITLE_LINES) * TITLE_LINE_H;
}

/** Connected components (undirected) in display order: chains by size desc, then the singles. Each component's nodes are display-sorted. */
export function taskComponents(nodes: readonly TaskNode[], edges: readonly TaskEdge[]): { chains: TaskNode[][]; singles: TaskNode[] } {
	const sorted = [...nodes].sort(compareTasks);
	const parent = new Map(sorted.map((n) => [n.id, n.id] as const));
	const find = (id: string): string => {
		let r = id;
		while (parent.get(r) !== r) r = parent.get(r)!;
		parent.set(id, r);
		return r;
	};
	for (const e of edges) if (parent.has(e.from) && parent.has(e.to)) parent.set(find(e.from), find(e.to));
	const groups = new Map<string, TaskNode[]>();
	for (const n of sorted) {
		const r = find(n.id);
		const g = groups.get(r);
		if (g) g.push(n);
		else groups.set(r, [n]);
	}
	const all = [...groups.values()];
	// groups are already in first-member display order; a stable sort by size keeps that for ties
	const chains = all.filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
	const singles = all.filter((g) => g.length === 1).map((g) => g[0]!);
	return { chains, singles };
}

export function layoutTaskGraph(nodes: readonly TaskNode[], edges: readonly TaskEdge[], opts: TaskLayoutOptions): TaskLayout {
	const gapX = opts.gapX ?? 24;
	const gapY = opts.gapY ?? 40;
	const w = opts.nodeWidth;
	const { chains, singles } = taskComponents(nodes, edges);
	const placed: PlacedTask[] = [];
	let y = 0;
	let width = 0;

	for (const comp of chains) {
		const ids = new Set(comp.map((n) => n.id));
		const g = new graphlib.Graph({ compound: false, multigraph: false });
		g.setGraph({ rankdir: "TB", nodesep: gapX, ranksep: gapY, marginx: 0, marginy: 0 });
		const heights = new Map(comp.map((n) => [n.id, taskNodeHeight(n.title, w)] as const));
		for (const n of comp) g.setNode(n.id, { width: w, height: heights.get(n.id)! });
		for (const e of edges) if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to, { label: "", width: 0, height: 0 });
		dagreLayout(g, undefined);
		let minX = Infinity;
		let maxX = -Infinity;
		let maxY = 0;
		for (const n of comp) {
			const p = g.node(n.id);
			minX = Math.min(minX, p.x - w / 2);
			maxX = Math.max(maxX, p.x + w / 2);
			maxY = Math.max(maxY, p.y + heights.get(n.id)! / 2);
		}
		for (const n of comp) {
			const p = g.node(n.id);
			const h = heights.get(n.id)!;
			placed.push({ id: n.id, x: Math.round(p.x - w / 2 - minX), y: Math.round(y + p.y - h / 2), w, h });
		}
		width = Math.max(width, maxX - minX);
		y += maxY + gapY;
	}

	if (singles.length > 0) {
		const cols = Math.max(1, Math.floor((opts.maxWidth + gapX) / (w + gapX)));
		const used = Math.min(cols, singles.length);
		for (let r = 0; r * used < singles.length; r++) {
			const row = singles.slice(r * used, (r + 1) * used);
			const rowH = Math.max(...row.map((n) => taskNodeHeight(n.title, w)));
			row.forEach((n, c) => placed.push({ id: n.id, x: c * (w + gapX), y, w, h: taskNodeHeight(n.title, w) }));
			y += rowH + gapY;
		}
		width = Math.max(width, used * w + (used - 1) * gapX);
	}

	return { nodes: placed, width: Math.round(width), height: placed.length ? Math.max(0, Math.round(y - gapY)) : 0 };
}
