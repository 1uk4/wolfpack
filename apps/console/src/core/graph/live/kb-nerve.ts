/**
 * NERVE (pure, no DOM): the path a filed entry's pulse runs down the KB tree, domain -> section(s) -> entry, and the geometry of a
 * polyline pulse (its head, and the lit stretch behind it). Drawing lives in components/graph/live/kb-life-draw.ts.
 */

export interface NervePt { x: number; y: number }
export interface NerveEdge { from: string; to: string }

/** Shortest path between two nodes over the edges (either direction), or null when they are not connected. */
function bfs(adj: Map<string, string[]>, from: string, to: string): string[] | null {
	if (from === to) return [from];
	const prev = new Map<string, string>([[from, from]]);
	const queue = [from];
	for (let i = 0; i < queue.length; i++) {
		const cur = queue[i]!;
		for (const nb of adj.get(cur) ?? []) {
			if (prev.has(nb)) continue;
			prev.set(nb, cur);
			if (nb === to) {
				const path = [to];
				for (let at = to; at !== from; ) path.unshift((at = prev.get(at)!));
				return path;
			}
			queue.push(nb);
		}
	}
	return null;
}

/**
 * The node ids a nerve pulse visits: from `dom` down the tree edges to `ent` (the sections between are on the way).
 * The event's own section chain (`chain`, ids without the `sec:` prefix), when it has one, is walked as it is; older events fall back to the tree search below.
 * An entry the map does not have yet (or cannot reach) ends the path at its section, or at the domain when that is missing too.
 */
export function nervePath(edges: readonly NerveEdge[], dom: string, sec?: string, ent?: string, chain?: readonly string[]): string[] {
	if (chain?.length) {
		// the event carries the whole chain: walk it hop by hop, and end at the last hop that has a tree edge (never a shortcut across a gap)
		const has = new Set(edges.map((e) => `${e.from}\u0000${e.to}`));
		const hop = (a: string, b: string) => has.has(`${a}\u0000${b}`) || has.has(`${b}\u0000${a}`);
		const out = [dom];
		for (const id of [...chain.map((s) => `sec:${s}`), ...(ent ? [ent] : [])]) {
			if (!hop(out[out.length - 1]!, id)) break;
			out.push(id);
		}
		return out;
	}
	const adj = new Map<string, string[]>();
	const link = (a: string, b: string) => (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
	for (const e of edges) {
		link(e.from, e.to);
		link(e.to, e.from);
	}
	return (ent && bfs(adj, dom, ent)) || (sec && bfs(adj, dom, sec)) || [dom];
}

/**
 * The node ids a hover or Activity highlight rings for a filed entry: its tree path (domain, sections, entry), the same as the nerve pulse.
 * Empty for any other target (only its own node rings). `sectionPath` is the event's own chain, when it has one.
 */
export function treePathOf(edges: readonly NerveEdge[], target: { kind: string; id: string; domain?: string }, sectionPath?: readonly string[]): string[] {
	if (target.kind !== "kb-entry" || !target.domain) return [];
	return nervePath(edges, `dom:${target.domain}`, undefined, `ent:${target.id}`, sectionPath);
}

const segLen = (a: NervePt, b: NervePt) => Math.hypot(b.x - a.x, b.y - a.y);

/** The point `dist` along the polyline (clamped to its ends). */
function pointAt(points: readonly NervePt[], dist: number): NervePt {
	let left = Math.max(0, dist);
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!;
		const b = points[i]!;
		const len = segLen(a, b);
		if (left <= len) return len === 0 ? { ...a } : { x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len };
		left -= len;
	}
	const last = points[points.length - 1];
	return last ? { ...last } : { x: 0, y: 0 };
}

const totalLen = (points: readonly NervePt[]) => points.slice(1).reduce((n, p, i) => n + segLen(points[i]!, p), 0);

/** The head of the pulse when it has run fraction `t` (0..1) of the polyline's length. */
export function nerveHead(points: readonly NervePt[], t: number): NervePt {
	return pointAt(points, Math.min(1, Math.max(0, t)) * totalLen(points));
}

/** The lit stretch: the polyline from `tailFrac` of its length behind the head (at fraction `t`) up to the head. */
export function nerveTrail(points: readonly NervePt[], t: number, tailFrac: number): NervePt[] {
	const total = totalLen(points);
	const end = Math.min(1, Math.max(0, t)) * total;
	const start = Math.max(0, end - Math.max(0, tailFrac) * total);
	const out: NervePt[] = [pointAt(points, start)];
	let at = 0;
	for (let i = 1; i < points.length; i++) {
		at += segLen(points[i - 1]!, points[i]!);
		if (at > start && at < end) out.push({ ...points[i]! });
	}
	out.push(pointAt(points, end));
	return out;
}
