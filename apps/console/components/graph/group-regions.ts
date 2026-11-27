/**
 * Group regions (work-wolfpack-FnzgC6g): the large soft bubble drawn behind a group's domain regions, its big title anchor, hit
 * testing (tap to zoom) and the box to zoom to. Pure maths plus one draw helper; the canvas calls these with the live node positions.
 */

export interface GroupInput {
	id: string;
	label: string;
	color: string;
	/** One member id list per domain of the group. */
	parts: ReadonlyArray<ReadonlyArray<string>>;
}

export interface GroupShape {
	id: string;
	label: string;
	color: string;
	/** Title anchor: the mean of the domain centres. */
	cx: number;
	cy: number;
	size: number;
	parts: { x: number; y: number; r: number }[];
	box: { minX: number; minY: number; maxX: number; maxY: number };
}

/** World units the bubble extends beyond a domain's outermost node. */
export const GROUP_PAD = 90;

export function computeGroupShapes(
	groups: readonly GroupInput[],
	pos: (id: string) => { x: number; y: number } | undefined,
	visible: ReadonlySet<string> | null,
): GroupShape[] {
	const out: GroupShape[] = [];
	for (const g of groups) {
		const parts: GroupShape["parts"] = [];
		let size = 0;
		for (const ids of g.parts) {
			const pts = ids.filter((id) => !visible || visible.has(id)).map(pos).filter((p): p is { x: number; y: number } => !!p);
			if (pts.length === 0) continue;
			const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
			const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
			const r = pts.reduce((m, p) => Math.max(m, Math.hypot(p.x - x, p.y - y)), 0) + GROUP_PAD;
			parts.push({ x, y, r });
			size += pts.length;
		}
		if (parts.length === 0) continue;
		const cx = parts.reduce((s, p) => s + p.x, 0) / parts.length;
		const cy = parts.reduce((s, p) => s + p.y, 0) / parts.length;
		const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
		for (const p of parts) {
			box.minX = Math.min(box.minX, p.x - p.r);
			box.minY = Math.min(box.minY, p.y - p.r);
			box.maxX = Math.max(box.maxX, p.x + p.r);
			box.maxY = Math.max(box.maxY, p.y + p.r);
		}
		out.push({ id: g.id, label: g.label, color: g.color, cx, cy, size, parts, box });
	}
	return out;
}

/** The group whose bubble contains this world point (the smallest wins when bubbles overlap), else null. */
export function groupAt(shapes: readonly GroupShape[], wx: number, wy: number): GroupShape | null {
	let best: GroupShape | null = null;
	for (const s of shapes) {
		const inside = s.parts.some((p) => Math.hypot(wx - p.x, wy - p.y) <= p.r) || Math.hypot(wx - s.cx, wy - s.cy) <= GROUP_PAD;
		if (inside && (!best || s.size < best.size)) best = s;
	}
	return best;
}

function rgba(hex: string, a: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return hex;
	const n = parseInt(m[1]!, 16);
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Soft bubbles in world coordinates: one radial wash per domain plus a wide faint band joining the domains to the group centre. */
export function drawGroupShapes(ctx: CanvasRenderingContext2D, shapes: readonly GroupShape[]): void {
	for (const s of shapes) {
		if (s.parts.length > 1) {
			ctx.save();
			ctx.strokeStyle = rgba(s.color, 0.07);
			ctx.lineCap = "round";
			ctx.lineWidth = Math.min(...s.parts.map((p) => p.r)) * 1.2;
			ctx.beginPath();
			for (const p of s.parts) {
				ctx.moveTo(s.cx, s.cy);
				ctx.lineTo(p.x, p.y);
			}
			ctx.stroke();
			ctx.restore();
		}
		for (const p of s.parts) {
			const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
			grad.addColorStop(0, rgba(s.color, 0.16));
			grad.addColorStop(0.7, rgba(s.color, 0.1));
			grad.addColorStop(1, rgba(s.color, 0));
			ctx.fillStyle = grad;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			ctx.fill();
		}
	}
}
