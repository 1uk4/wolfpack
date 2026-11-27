/**
 * Semantic-zoom labels for the knowledge graph (work-wolfpack-Wu0RH2z). Pure: no canvas, no DOM.
 *
 * Every label belongs to a LEVEL from the top: 0 group titles, 1 domains and big sections, 2 deeper sections and features, 3 leaves
 * (entries, tasks). The level comes from hierarchy depth AND size (child count) together. Zoomed out only the top levels are
 * eligible; each zoom step reveals the next. Eligible labels then compete for room: the higher level wins a collision and the
 * other hides. Hovering or selecting a node always shows its label and its parent chain.
 *
 * ALL THRESHOLDS LIVE IN LABEL_LEVELS below (and the two size knobs next to it).
 */

export type LabelLevel = 0 | 1 | 2 | 3;

export interface LabelLevelSpec {
	level: LabelLevel;
	/** Visible from this effective zoom (1 = the whole graph fits; larger = closer). */
	minZoom: number;
	/** Hidden from this effective zoom on (Infinity = never). Group titles hand over to the domain labels. */
	maxZoom: number;
	/** Font size on screen, px (screen-fixed, so a title is the same size at any zoom). */
	px: number;
	weight: number;
	/** Text opacity: deeper levels are muted. */
	opacity: number;
}

/** THE threshold table: zoom ranges, type size, weight and opacity per level. */
export const LABEL_LEVELS: readonly LabelLevelSpec[] = [
	{ level: 0, minZoom: 0, maxZoom: 1.1, px: 24, weight: 700, opacity: 1 },
	{ level: 1, minZoom: 0, maxZoom: Infinity, px: 15, weight: 650, opacity: 0.95 },
	{ level: 2, minZoom: 1.4, maxZoom: Infinity, px: 12, weight: 550, opacity: 0.8 },
	{ level: 3, minZoom: 2.4, maxZoom: Infinity, px: 11, weight: 400, opacity: 0.65 },
];

/** A section or feature with at least this many children counts one level higher ("big sections"). */
export const BIG_PARENT_CHILDREN = 12;
/** The zoom setting's default; the table above is written for it (see effectiveZoom). */
export const LABEL_ZOOM_REFERENCE = 0.5;
/** Seconds-ish: how long a label takes to fade in or out. */
export const LABEL_FADE_MS = 160;

/** The camera zoom (multiple of the fit zoom) scaled by the Labels-until-zoom setting: a higher setting reveals labels sooner. */
export function effectiveZoom(zoomMultiple: number, labelZoom: number): number {
	return (zoomMultiple * labelZoom) / LABEL_ZOOM_REFERENCE;
}

/** Which levels are eligible at this effective zoom. */
export function eligibleAt(level: LabelLevel, ze: number): boolean {
	const s = LABEL_LEVELS[level]!;
	return ze >= s.minZoom && ze < s.maxZoom;
}

export interface LabelTreeNode {
	/** A domain (depth 0): wins every collision against a section of the same level. */
	domain: boolean;
	level: LabelLevel;
	childCount: number;
	parent: string | null;
}

/**
 * Level, size and parent for every node from the hierarchy edges (parent → child) and the depths (domain 0 → section 1 → entry 2 →
 * work 2+). Depth sets the base level (0 → 1, 1 → 2, deeper → 3); a leaf is always level 3, a parent is never below 2, and a big
 * parent (BIG_PARENT_CHILDREN children) moves up one level.
 */
export function buildLabelTree(
	ids: Iterable<string>,
	edges: ReadonlyArray<{ from: string; to: string }>,
	depths: ReadonlyMap<string, number>,
	/** Bucket nodes (Inbox, Factory): never promoted by child count. */
	isBucket?: (id: string) => boolean,
): Map<string, LabelTreeNode> {
	const out = new Map<string, LabelTreeNode>();
	for (const id of ids) out.set(id, { domain: (depths.get(id) ?? 2) === 0, level: 3, childCount: 0, parent: null });
	for (const e of edges) {
		const p = out.get(e.from);
		const c = out.get(e.to);
		if (!p || !c || e.from === e.to) continue;
		if ((depths.get(e.from) ?? 0) >= (depths.get(e.to) ?? 0)) continue; // only downward links form the chain
		p.childCount++;
		if (c.parent === null) c.parent = e.from;
	}
	for (const [id, n] of out) {
		const d = depths.get(id) ?? 2;
		if (n.childCount === 0) {
			n.level = d === 0 ? 1 : 3;
			continue;
		}
		let level = d <= 0 ? 1 : 2;
		if (n.childCount >= BIG_PARENT_CHILDREN && !isBucket?.(id)) level -= 1;
		n.level = Math.min(3, Math.max(1, level)) as LabelLevel;
	}
	return out;
}

/** The node, then its parent, grandparent, … (cycle-safe). */
export function parentChain(id: string, tree: ReadonlyMap<string, LabelTreeNode>): string[] {
	const chain: string[] = [];
	const seen = new Set<string>();
	let cur: string | null = id;
	while (cur && !seen.has(cur) && tree.has(cur)) {
		seen.add(cur);
		chain.push(cur);
		cur = tree.get(cur)!.parent;
	}
	return chain;
}

export interface LabelCandidate {
	id: string;
	level: LabelLevel;
	/** Child count: breaks ties inside a level (bigger first). */
	size: number;
	/** Screen position of the anchor (a node centre, or a group title's centre). */
	sx: number;
	sy: number;
	/** Screen px between the anchor and the label's top (node radius + gap); 0 centres the text on the anchor. */
	below: number;
	/** Text width at 1 px of font size (measured once, never per frame). */
	widthEm: number;
	/** Font scale on top of the level's px (the cluster label size setting); default 1. */
	scale?: number;
	/** A domain label: outranks a section at the same level whatever the sizes. */
	domain?: boolean;
}

interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

const LINE_EM = 1.25;
const PAD = 3;
const CELL = 96;

/** Screen y of a label's top edge: just below the anchor by `below`, or (below 0) the text centred on it. ONE formula for the collision rect and the draw. */
export function labelTop(sy: number, below: number, px: number): number {
	return below === 0 ? sy - (px * LINE_EM) / 2 : sy + below;
}

function rectOf(c: LabelCandidate): Rect {
	const px = LABEL_LEVELS[c.level]!.px * (c.scale ?? 1);
	const w = c.widthEm * px;
	const h = px * LINE_EM;
	const top = labelTop(c.sy, c.below, px);
	return { x0: c.sx - w / 2 - PAD, x1: c.sx + w / 2 + PAD, y0: top - PAD, y1: top + h + PAD };
}

/** A disc on screen that labels must not cover (a wolf badge): screen px. */
export interface LabelObstacle {
	sx: number;
	sy: number;
	r: number;
}

function hitsObstacle(r: Rect, obstacles: readonly LabelObstacle[] | undefined): boolean {
	if (!obstacles) return false;
	for (const o of obstacles) {
		const dx = o.sx - Math.min(Math.max(o.sx, r.x0), r.x1);
		const dy = o.sy - Math.min(Math.max(o.sy, r.y0), r.y1);
		if (dx * dx + dy * dy < o.r * o.r) return true;
	}
	return false;
}

/**
 * The labels to draw. `forced` ids (hover / selection and their parent chain) are placed first and always shown. The rest, already
 * limited to the eligible levels by the caller or not, are placed by level (higher first), then size, then id; one that touches an
 * already placed label hides. Off-screen candidates are skipped before any work.
 */
export function chooseLabels(
	candidates: readonly LabelCandidate[],
	opts: { ze: number; width: number; height: number; forced?: ReadonlySet<string>; obstacles?: readonly LabelObstacle[] },
): Set<string> {
	const forced = opts.forced ?? new Set<string>();
	const margin = 40;
	const pool = candidates.filter((c) => {
		if (forced.has(c.id)) return true;
		if (!eligibleAt(c.level, opts.ze)) return false;
		return c.sx > -margin && c.sx < opts.width + margin && c.sy > -margin && c.sy < opts.height + margin;
	});
	pool.sort((a, b) => {
		const fa = forced.has(a.id) ? 0 : 1;
		const fb = forced.has(b.id) ? 0 : 1;
		if (fa !== fb) return fa - fb;
		if (a.level !== b.level) return a.level - b.level;
		if (!!a.domain !== !!b.domain) return a.domain ? -1 : 1;
		if (a.size !== b.size) return b.size - a.size;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	const grid = new Map<number, Rect[]>();
	const keyOf = (cx: number, cy: number) => cx * 65536 + cy;
	const hits = (r: Rect): boolean => {
		for (let cx = Math.floor(r.x0 / CELL); cx <= Math.floor(r.x1 / CELL); cx++)
			for (let cy = Math.floor(r.y0 / CELL); cy <= Math.floor(r.y1 / CELL); cy++)
				for (const o of grid.get(keyOf(cx, cy)) ?? []) if (r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0) return true;
		return false;
	};
	const put = (r: Rect): void => {
		for (let cx = Math.floor(r.x0 / CELL); cx <= Math.floor(r.x1 / CELL); cx++)
			for (let cy = Math.floor(r.y0 / CELL); cy <= Math.floor(r.y1 / CELL); cy++) {
				const k = keyOf(cx, cy);
				const list = grid.get(k);
				if (list) list.push(r);
				else grid.set(k, [r]);
			}
	};
	const shown = new Set<string>();
	for (const c of pool) {
		const r = rectOf(c);
		if (!forced.has(c.id) && (hits(r) || hitsObstacle(r, opts.obstacles))) continue;
		put(r);
		shown.add(c.id);
	}
	return shown;
}

/** Catch-all bucket nodes ("Inbox", "Factory", "Unsorted"): big because they collect, not because they matter. */
export function isBucketLabel(label: string): boolean {
	return /^(inbox|factory|unsorted|misc(ellaneous)?|uncategori[sz]ed|other)$/i.test(label.trim());
}

/** One fade step: every label moves toward 1 (shown) or 0 (hidden). Reduced motion jumps. Drops labels that reached 0. */
export function stepLabelFades(fades: Map<string, number>, shown: ReadonlySet<string>, dtMs: number, reduce: boolean): boolean {
	const step = reduce ? 1 : Math.min(1, dtMs / LABEL_FADE_MS);
	let moving = false;
	for (const id of shown) {
		const a = fades.get(id) ?? 0;
		if (a < 1) {
			fades.set(id, Math.min(1, a + step));
			moving = moving || a + step < 1;
		}
	}
	for (const [id, a] of fades) {
		if (shown.has(id)) continue;
		const next = a - step;
		if (next <= 0) fades.delete(id);
		else {
			fades.set(id, next);
			moving = true;
		}
	}
	return moving;
}
