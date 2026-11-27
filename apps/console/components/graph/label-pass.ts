/**
 * The semantic-zoom label pass (work-wolfpack-Wu0RH2z): draws every label of the graph, in screen space, from the pure choice in
 * src/core/graph/label-lod.ts (levels, thresholds, collisions). The canvas owns the camera and the nodes; this owns the label
 * state: the level tree, the text widths (measured lazily, once per id and font, only for labels that become eligible), the last
 * choice and the fades. The per-frame path allocates nothing: scratch sets and arrays are fields.
 */
import { LABEL_FADE_MS, LABEL_LEVELS, buildLabelTree, chooseLabels, eligibleAt, labelTop, parentChain, redactLines, stepLabelFades, type LabelCandidate, type LabelLevel, type LabelTreeNode } from "@/src/core";

export interface LabelNode {
	id: string;
	x: number;
	y: number;
	label: string;
	color?: string;
}

export interface GroupTitle {
	id: string;
	label: string;
	color: string;
	x: number;
	y: number;
	size: number;
}

export interface LabelFrame {
	ctx: CanvasRenderingContext2D;
	/** Camera: screen = world * k + (tx, ty). */
	tx: number;
	ty: number;
	k: number;
	w: number;
	h: number;
	/** Effective zoom (label-lod effectiveZoom). */
	ze: number;
	/** The Labels toggle: off keeps only hover / selection labels. */
	on: boolean;
	/** The cluster labels toggle: off hides the level 0-1 titles (groups, domains, big sections) except hover / selection. */
	clusterLabels: boolean;
	/** Font scale of those level 0-1 titles (the cluster label size setting over its default). */
	clusterScale: number;
	hoverId: string | null;
	selectedId: string | null;
	reduce: boolean;
	privateView: boolean;
	textColor: string;
	fontFamily: string;
	nodes: ReadonlyMap<string, LabelNode>;
	/** Disc radius in world units (the label sits just below it). */
	radiusOf: (n: LabelNode) => number;
	visible: ReadonlySet<string> | null;
	/** Stable identity while the groups are unchanged (the choice is recomputed only when it or geoVersion changes). */
	groups: readonly GroupTitle[];
	geoVersion: number;
	now: number;
}

const MAX_CHARS: Record<LabelLevel, number> = { 0: 28, 1: 30, 2: 34, 3: 38 };

function clip(text: string, level: LabelLevel): string {
	const max = MAX_CHARS[level];
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function withAlpha(hex: string, a: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return hex;
	const n = parseInt(m[1]!, 16);
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** What the last choice was computed for: compared field by field, so a frame that changed nothing builds no key string. */
interface ChoiceKey {
	tx: number;
	ty: number;
	k: number;
	w: number;
	h: number;
	ze: number;
	on: boolean;
	clusterLabels: boolean;
	clusterScale: number;
	geoVersion: number;
	hoverId: string | null;
	selectedId: string | null;
	groups: readonly GroupTitle[] | null;
	visible: ReadonlySet<string> | null;
	visibleSize: number;
	nodes: unknown;
	nodeCount: number;
	tree: unknown;
}

/** A measured label: valid while its text, level and the font family are unchanged. */
interface Measured {
	label: string;
	level: LabelLevel;
	text: string;
	widthEm: number;
}

export class LabelPass {
	private tree = new Map<string, LabelTreeNode>();
	private measured = new Map<string, Measured>();
	private measuredFont = "";
	private fades = new Map<string, number>();
	private shown = new Set<string>();
	private choice: ChoiceKey | null = null;
	private lastNow = 0;
	private moving = false;
	// Scratch reused every frame.
	private readonly forced = new Set<string>();
	private readonly cands: LabelCandidate[] = [];
	private order: string[] = [];
	private orderDirty = true;
	private orderFadeCount = -1;
	private groupById = new Map<string, GroupTitle>();
	private groupByIdFor: readonly GroupTitle[] | null = null;

	/** New hierarchy (edges parent → child, depths per node id). Measured widths stay cached by id; the choice is recomputed. */
	setHierarchy(ids: Iterable<string>, edges: ReadonlyArray<{ from: string; to: string }>, depths: ReadonlyMap<string, number>): void {
		this.tree = buildLabelTree(ids, edges, depths);
		this.choice = null;
	}

	/** True while a fade is still moving: the canvas keeps asking for frames. */
	needsFrames(): boolean {
		return this.moving;
	}

	/** One frame. Cheap when nothing changed: the choice is cached, only the fades step. */
	draw(f: LabelFrame): void {
		const { ctx } = f;
		if (f.fontFamily !== this.measuredFont) {
			this.measuredFont = f.fontFamily;
			this.measured.clear();
			this.choice = null;
		}
		const forced = this.forced;
		forced.clear();
		if (f.hoverId) for (const c of parentChain(f.hoverId, this.tree)) forced.add(c);
		if (f.selectedId) for (const c of parentChain(f.selectedId, this.tree)) forced.add(c);

		if (this.groupByIdFor !== f.groups) {
			this.groupByIdFor = f.groups;
			this.groupById.clear();
			for (const g of f.groups) this.groupById.set(`group:${g.id}`, g);
		}
		const groupById = this.groupById;

		if (this.choiceChanged(f)) {
			this.orderDirty = true;
			this.cands.length = 0;
			const cands = this.cands;
			const showTitles = f.clusterLabels;
			if (f.on || forced.size > 0) {
				for (const [id, n] of f.nodes) {
					const t = this.tree.get(id);
					if (!t || (f.visible && !f.visible.has(id))) continue;
					if (!f.on && !forced.has(id)) continue;
					const isForced = forced.has(id);
					if (!isForced && (!eligibleAt(t.level, f.ze) || (!showTitles && t.level <= 1))) continue;
					const m = this.measure(f, id, n.label, t.level);
					cands.push({ id, level: t.level, size: t.childCount, sx: n.x * f.k + f.tx, sy: n.y * f.k + f.ty, below: f.radiusOf(n) * f.k + 2, widthEm: m.widthEm, ...(t.level <= 1 ? { scale: f.clusterScale } : {}) });
				}
				if (f.on && showTitles) {
					for (const g of f.groups) {
						if (!eligibleAt(0, f.ze)) break;
						const m = this.measure(f, `group:${g.id}`, g.label, 0);
						cands.push({ id: `group:${g.id}`, level: 0, size: g.size, sx: g.x * f.k + f.tx, sy: g.y * f.k + f.ty, below: 0, widthEm: m.widthEm, scale: f.clusterScale });
					}
				}
			}
			this.shown = chooseLabels(cands, { ze: f.ze, width: f.w, height: f.h, forced });
		}

		const dt = this.lastNow ? Math.min(Math.max(f.now - this.lastNow, 0), 100) : LABEL_FADE_MS;
		this.lastNow = f.now;
		this.moving = stepLabelFades(this.fades, this.shown, dt, f.reduce);
		if (!this.moving) this.lastNow = 0;

		// Draw low levels first so the higher ones sit on top. Re-sorted only when the set of fading labels changed.
		if (this.orderDirty || this.fades.size !== this.orderFadeCount) {
			this.orderDirty = false;
			this.orderFadeCount = this.fades.size;
			const order = this.order;
			order.length = 0;
			for (const id of this.fades.keys()) order.push(id);
			if (order.length > 1) order.sort((a, b) => this.levelOf(b, groupById) - this.levelOf(a, groupById));
		}

		ctx.save();
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (const id of this.order) {
			const alpha = this.fades.get(id);
			if (alpha === undefined) continue;
			const g = groupById.get(id);
			const level = this.levelOf(id, groupById);
			const spec = LABEL_LEVELS[level]!;
			const px = level <= 1 ? spec.px * f.clusterScale : spec.px;
			let x: number;
			let y: number;
			let color: string;
			let text: string;
			if (g) {
				x = g.x * f.k + f.tx;
				y = labelTop(g.y * f.k + f.ty, 0, px);
				color = g.color;
				text = this.measured.get(id)?.text ?? g.label;
			} else {
				const n = f.nodes.get(id);
				if (!n) continue;
				x = n.x * f.k + f.tx;
				y = labelTop(n.y * f.k + f.ty, f.radiusOf(n) * f.k + 2, px);
				color = level <= 1 ? (n.color ?? f.textColor) : f.textColor;
				text = this.measured.get(id)?.text ?? n.label;
			}
			const hot = id === f.hoverId || id === f.selectedId;
			ctx.font = `${hot ? Math.max(spec.weight, 600) : spec.weight} ${px}px ${f.fontFamily}`;
			ctx.fillStyle = withAlpha(color, alpha * (hot ? 1 : spec.opacity));
			ctx.fillText(f.privateView ? (redactLines([text], true)[0] ?? text) : text, x, y);
		}
		ctx.restore();
	}

	private choiceChanged(f: LabelFrame): boolean {
		const c = this.choice;
		const size = f.visible ? f.visible.size : -1;
		if (
			c &&
			c.tx === f.tx && c.ty === f.ty && c.k === f.k && c.w === f.w && c.h === f.h && c.ze === f.ze && c.on === f.on &&
			c.clusterLabels === f.clusterLabels && c.clusterScale === f.clusterScale && c.geoVersion === f.geoVersion &&
			c.hoverId === f.hoverId && c.selectedId === f.selectedId && c.groups === f.groups && c.visible === f.visible &&
			c.visibleSize === size && c.nodes === f.nodes && c.nodeCount === f.nodes.size && c.tree === this.tree
		) {
			return false;
		}
		this.choice = { tx: f.tx, ty: f.ty, k: f.k, w: f.w, h: f.h, ze: f.ze, on: f.on, clusterLabels: f.clusterLabels, clusterScale: f.clusterScale, geoVersion: f.geoVersion, hoverId: f.hoverId, selectedId: f.selectedId, groups: f.groups, visible: f.visible, visibleSize: size, nodes: f.nodes, nodeCount: f.nodes.size, tree: this.tree };
		return true;
	}

	private levelOf(id: string, groups: ReadonlyMap<string, GroupTitle>): LabelLevel {
		return groups.has(id) ? 0 : (this.tree.get(id)?.level ?? 3);
	}

	/** The width of a label, measured the first time it is needed and again only when its text or level changes (or the font family does). */
	private measure(f: LabelFrame, id: string, label: string, level: LabelLevel): Measured {
		const have = this.measured.get(id);
		if (have && have.label === label && have.level === level) return have;
		const { ctx } = f;
		const text = clip(label, level);
		ctx.save();
		ctx.font = `${LABEL_LEVELS[level]!.weight} 100px ${f.fontFamily}`;
		const m: Measured = { label, level, text, widthEm: ctx.measureText(text).width / 100 };
		ctx.restore();
		this.measured.set(id, m);
		return m;
	}
}
