/**
 * Layered layout of a plan graph (pure, deterministic, DOM-free). Edges mean depends-on (`from` depends on `to`), so a
 * node's rank is the longest chain of prerequisites behind it (longest-path ranking): rank 0 has none, and work flows
 * left to right. Within a rank nodes keep their input order, nudged by one barycenter pass; there is NO general
 * crossing reduction, so dense graphs can have crossing edges. Sizes are fixed so the drawn cards and the layout agree exactly.
 * (The task graph's dagre placement is tied to TaskNode statuses and packs components for a panel; a chat card wants
 * plain ranks, hence this small sibling rather than a second dagre setup.)
 */
import type { GraphEdge } from "@wolfpack/protocol/objects";

export interface GraphLayoutOptions {
	nodeWidth?: number;
	nodeHeight?: number;
	gapX?: number;
	gapY?: number;
	/** Ids drawn as thin bars (done / skipped slivers): `slimHeight` tall, and a column of only slivers is `slimWidth` wide. */
	slim?: ReadonlySet<string>;
	slimHeight?: number;
	slimWidth?: number;
}

export interface PlacedGraphNode {
	id: string;
	rank: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface GraphLayout {
	nodes: PlacedGraphNode[];
	/** One entry per edge: the path from the prerequisite's right side to the dependent's left side. */
	edges: Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }>;
	width: number;
	height: number;
	nodeWidth: number;
	nodeHeight: number;
}

/**
 * Rank of every node: 0 without prerequisites, else 1 + the max rank of what it depends on (longest path). Iterative
 * (Kahn), so a deep chain cannot blow the stack. Cycle-safe: nodes on or behind a cycle stay at rank 0.
 */
export function graphRanks(ids: readonly string[], edges: readonly GraphEdge[]): Map<string, number> {
	const rank = new Map<string, number>(ids.map((id) => [id, 0]));
	const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
	const pending = new Map<string, number>(ids.map((id) => [id, 0]));
	for (const e of edges) {
		if (!rank.has(e.from) || !rank.has(e.to) || e.from === e.to) continue;
		dependents.get(e.to)!.push(e.from);
		pending.set(e.from, pending.get(e.from)! + 1);
	}
	const queue = ids.filter((id) => pending.get(id) === 0);
	for (let i = 0; i < queue.length; i++) {
		const id = queue[i]!;
		for (const dep of dependents.get(id)!) {
			rank.set(dep, Math.max(rank.get(dep)!, rank.get(id)! + 1));
			const left = pending.get(dep)! - 1;
			pending.set(dep, left);
			if (left === 0) queue.push(dep);
		}
	}
	return rank;
}

export function layoutGraph(nodes: ReadonlyArray<{ id: string }>, edges: readonly GraphEdge[], opts: GraphLayoutOptions = {}): GraphLayout {
	const nodeWidth = opts.nodeWidth ?? 148;
	const nodeHeight = opts.nodeHeight ?? 56;
	const gapX = opts.gapX ?? 36;
	const gapY = opts.gapY ?? 12;
	const ranks = graphRanks(nodes.map((n) => n.id), edges);
	// Rows within a rank: input order, then a one-pass barycenter sweep (left to right) pulls a node toward the mean
	// row of its already-placed prerequisites, which untangles the common cases cheaply.
	const columns: string[][] = [];
	for (const n of nodes) (columns[ranks.get(n.id)!] ??= []).push(n.id);
	const prereqs = new Map<string, string[]>();
	for (const e of edges) if (ranks.has(e.from) && ranks.has(e.to)) (prereqs.get(e.from) ?? prereqs.set(e.from, []).get(e.from)!).push(e.to);
	const row = new Map<string, number>();
	const rowCount = new Map<number, number>();
	columns.forEach((col, rank) => {
		if (!col) return;
		const key = (id: string, i: number): number => {
			const ps = (prereqs.get(id) ?? []).filter((p) => row.has(p));
			return ps.length ? ps.reduce((a, p) => a + row.get(p)!, 0) / ps.length : i;
		};
		const ordered = col.map((id, i) => ({ id, i, k: key(id, i) })).sort((a, b) => a.k - b.k || a.i - b.i);
		ordered.forEach((o, r) => row.set(o.id, r));
		rowCount.set(rank, col.length);
	});
	const slim = opts.slim ?? new Set<string>();
	const slimHeight = opts.slimHeight ?? 8;
	const slimWidth = opts.slimWidth ?? 36;
	const slimGap = Math.min(gapY, 4);
	// Column widths: a column of only slivers is narrow. Heights stack per column (a sliver is short, with a tight gap).
	const colWidth: number[] = columns.map((col) => (col && col.length > 0 && col.every((id) => slim.has(id)) ? slimWidth : nodeWidth));
	const colX: number[] = [];
	let cursorX = 0;
	for (let c = 0; c < columns.length; c++) {
		colX[c] = cursorX;
		cursorX += (colWidth[c] ?? nodeWidth) + gapX;
	}
	const placed: PlacedGraphNode[] = [];
	let totalHeight = 0;
	columns.forEach((col, rank) => {
		if (!col) return;
		let y = 0;
		let prevSlim = false;
		const ordered = [...col].sort((a, b) => row.get(a)! - row.get(b)!);
		ordered.forEach((id, i) => {
			const isSlim = slim.has(id);
			if (i > 0) y += isSlim || prevSlim ? slimGap : gapY;
			const h = isSlim ? slimHeight : nodeHeight;
			placed.push({ id, rank, x: colX[rank]!, y, width: colWidth[rank]!, height: h });
			y += h;
			prevSlim = isSlim;
		});
		totalHeight = Math.max(totalHeight, y);
	});
	const order = new Map(nodes.map((n, i) => [n.id, i] as const));
	placed.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
	const at = new Map(placed.map((p) => [p.id, p] as const));
	const out: GraphLayout["edges"] = [];
	for (const e of edges) {
		const prereq = at.get(e.to);
		const dependent = at.get(e.from);
		if (!prereq || !dependent) continue;
		out.push({ from: e.from, to: e.to, x1: prereq.x + prereq.width, y1: prereq.y + prereq.height / 2, x2: dependent.x, y2: dependent.y + dependent.height / 2 });
	}
	const cols = placed.length ? Math.max(...placed.map((p) => p.rank)) + 1 : 0;
	return {
		nodes: placed,
		edges: out,
		width: cols ? (colX[cols - 1] ?? 0) + (colWidth[cols - 1] ?? nodeWidth) : 0,
		height: totalHeight,
		nodeWidth,
		nodeHeight,
	};
}
