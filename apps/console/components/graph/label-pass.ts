/**
 * The semantic-zoom label pass (work-wolfpack-Wu0RH2z): draws every label of the graph, in screen space, from the pure choice in
 * src/core/graph/label-lod.ts (levels, thresholds, collisions). The canvas owns the camera and the nodes; this owns the label
 * state: the level tree, the text widths (measured once per data/font, never per frame), the last choice and the fades.
 */
import { LABEL_FADE_MS, LABEL_LEVELS, buildLabelTree, chooseLabels, parentChain, redactLines, stepLabelFades, type LabelCandidate, type LabelLevel, type LabelTreeNode } from "@/src/core";

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

export class LabelPass {
	private tree = new Map<string, LabelTreeNode>();
	private text = new Map<string, string>();
	private widthEm = new Map<string, number>();
	private measuredFor: { fontFamily: string; nodes: unknown } | null = null;
	private fades = new Map<string, number>();
	private shown = new Set<string>();
	private chosenKey = "";
	private lastNow = 0;
	private moving = false;

	/** New hierarchy (edges parent → child, depths per node id). */
	setHierarchy(ids: Iterable<string>, edges: ReadonlyArray<{ from: string; to: string }>, depths: ReadonlyMap<string, number>): void {
		this.tree = buildLabelTree(ids, edges, depths);
		this.measuredFor = null;
		this.chosenKey = "";
	}

	/** True while a fade is still moving: the canvas keeps asking for frames. */
	needsFrames(): boolean {
		return this.moving;
	}

	/** One frame. Cheap when the camera did not move: the choice is cached, only the fades step. */
	draw(f: LabelFrame): void {
		const { ctx } = f;
		this.measure(f);

		const forced = new Set<string>();
		for (const id of [f.hoverId, f.selectedId]) if (id) for (const c of parentChain(id, this.tree)) forced.add(c);

		const key = `${f.tx}|${f.ty}|${f.k}|${f.w}|${f.h}|${f.ze}|${f.on}|${f.geoVersion}|${f.hoverId}|${f.selectedId}|${f.groups.length}`;
		if (key !== this.chosenKey) {
			this.chosenKey = key;
			const cands: LabelCandidate[] = [];
			if (f.on || forced.size > 0) {
				for (const [id, n] of f.nodes) {
					const t = this.tree.get(id);
					if (!t || (f.visible && !f.visible.has(id))) continue;
					const wEm = this.widthEm.get(id);
					if (wEm === undefined) continue;
					if (!f.on && !forced.has(id)) continue;
					cands.push({ id, level: t.level, size: t.childCount, sx: n.x * f.k + f.tx, sy: n.y * f.k + f.ty, below: f.radiusOf(n) * f.k + 2, widthEm: wEm });
				}
				if (f.on) {
					for (const g of f.groups) {
						const wEm = this.widthEm.get(`group:${g.id}`);
						if (wEm === undefined) continue;
						cands.push({ id: `group:${g.id}`, level: 0, size: g.size, sx: g.x * f.k + f.tx, sy: g.y * f.k + f.ty, below: 0, widthEm: wEm });
					}
				}
			}
			this.shown = chooseLabels(cands, { ze: f.ze, width: f.w, height: f.h, forced });
		}

		const dt = this.lastNow ? Math.min(Math.max(f.now - this.lastNow, 0), 100) : LABEL_FADE_MS;
		this.lastNow = f.now;
		this.moving = stepLabelFades(this.fades, this.shown, dt, f.reduce);
		if (!this.moving) this.lastNow = 0;

		ctx.save();
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		const groupById = new Map(f.groups.map((g) => [`group:${g.id}`, g]));
		// Draw low levels first so the higher ones sit on top.
		const order = [...this.fades.keys()].sort((a, b) => this.levelOf(b, groupById) - this.levelOf(a, groupById));
		for (const id of order) {
			const alpha = this.fades.get(id) ?? 0;
			const g = groupById.get(id);
			const level = this.levelOf(id, groupById);
			const spec = LABEL_LEVELS[level]!;
			let x: number;
			let y: number;
			let color: string;
			let text: string;
			if (g) {
				x = g.x * f.k + f.tx;
				y = g.y * f.k + f.ty - spec.px * 0.6;
				color = g.color;
				text = this.text.get(id) ?? g.label;
			} else {
				const n = f.nodes.get(id);
				if (!n) continue;
				x = n.x * f.k + f.tx;
				y = n.y * f.k + f.ty + f.radiusOf(n) * f.k + 2;
				color = level <= 1 ? (n.color ?? f.textColor) : f.textColor;
				text = this.text.get(id) ?? n.label;
			}
			const hot = id === f.hoverId || id === f.selectedId;
			ctx.font = `${hot ? Math.max(spec.weight, 600) : spec.weight} ${spec.px}px ${f.fontFamily}`;
			ctx.fillStyle = withAlpha(color, alpha * (hot ? 1 : spec.opacity));
			ctx.fillText(redactLines([text], f.privateView)[0] ?? text, x, y);
		}
		ctx.restore();
	}

	private levelOf(id: string, groups: ReadonlyMap<string, GroupTitle>): LabelLevel {
		return groups.has(id) ? 0 : (this.tree.get(id)?.level ?? 3);
	}

	/** Text widths, once per data, visible set and font (hidden labels are never measured per frame). */
	private measure(f: LabelFrame): void {
		const groupSig = f.groups.map((g) => `${g.id}:${g.label}`).join("|");
		const sig = `${f.fontFamily}|${groupSig}`;
		if (this.measuredFor && this.measuredFor.nodes === f.nodes && this.measuredFor.fontFamily === sig) return;
		this.measuredFor = { fontFamily: sig, nodes: f.nodes };
		const { ctx } = f;
		ctx.save();
		this.widthEm = new Map();
		this.text = new Map();
		const put = (id: string, label: string, level: LabelLevel): void => {
			const spec = LABEL_LEVELS[level]!;
			const t = clip(label, level);
			ctx.font = `${spec.weight} 100px ${f.fontFamily}`;
			this.text.set(id, t);
			this.widthEm.set(id, ctx.measureText(t).width / 100);
		};
		for (const [id, n] of f.nodes) put(id, n.label, this.tree.get(id)?.level ?? 3);
		for (const g of f.groups) put(`group:${g.id}`, g.label, 0);
		ctx.restore();
	}
}
