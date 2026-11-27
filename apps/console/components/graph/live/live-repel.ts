/**
 * SOFT-BODY REPULSION between the live badges (pure; work-wolfpack-1Djd6IR): home wolves, feature threads and sub-agents push each other
 * apart along the line between their centres, mass-weighted, with a short springy bounce (restitution impulse + damping) and a gentle
 * longer-range push that falls to zero at `repelRangeMul` x the contact distance. A badge that is parked at a KB node also keeps clear
 * of it. Each body keeps an OFFSET (rx, ry) from where its owner places it; the owner adds the offset to the position every frame, so a
 * feature group moves as one (its sub-agents are placed from the group's centre) and nothing is left behind.
 * Allocation-free: callers keep one Repeller per body (created once) and pass a reused array.
 */
import type { LiveTuning } from "./live-tuning";

export interface Repeller {
	/** Current world position, offset included (the caller refreshes it every frame before the step). */
	x: number;
	y: number;
	/** The repulsion offset from the body's own place (world) and its velocity (world per second). */
	rx: number;
	ry: number;
	rvx: number;
	rvy: number;
	/** Radius (world). */
	r: number;
	mass: number;
	/** Bodies of one feature group (the feature and its sub-agents) never repel each other: the even ring spacing handles that. -1 = none. */
	grp: number;
	/** Spring (1/s) pulling the offset back to zero, and the most it may stretch (world; Infinity = free). */
	relax: number;
	maxOff: number;
	/** A KB node to keep clear of (world centre and radius; `nr` 0 = none). */
	nx: number;
	ny: number;
	nr: number;
	/** Direction (radians) to split two bodies that sit exactly on each other. */
	ang: number;
}

export function newRepeller(): Repeller {
	return { x: 0, y: 0, rx: 0, ry: 0, rvx: 0, rvy: 0, r: 0, mass: 1, grp: -1, relax: 0, maxOff: Number.POSITIVE_INFINITY, nx: 0, ny: 0, nr: 0, ang: 0 };
}

/** Refresh a body's per-frame inputs in place (no allocation). */
export function setRep(r: Repeller, x: number, y: number, rad: number, mass: number, grp: number, relax: number, maxOff: number, nr: number, ang: number): void {
	r.x = x;
	r.y = y;
	r.r = rad;
	r.mass = mass;
	r.grp = grp;
	r.relax = relax;
	r.maxOff = maxOff;
	r.nr = nr;
	r.ang = ang;
}

const EPS = 1e-6;

function move(b: Repeller, dx: number, dy: number): void {
	b.x += dx;
	b.y += dy;
	b.rx += dx;
	b.ry += dy;
}

/** Keep a sub-agent within its tether: the offset's length is capped and its outward velocity dropped. */
function capOffset(b: Repeller): void {
	const len = Math.hypot(b.rx, b.ry);
	if (len <= b.maxOff || len < EPS) return;
	const nx = b.rx / len;
	const ny = b.ry / len;
	move(b, nx * (b.maxOff - len), ny * (b.maxOff - len));
	const out = b.rvx * nx + b.rvy * ny;
	if (out > 0) {
		b.rvx -= nx * out;
		b.rvy -= ny * out;
	}
}

/** Separate one pair along the line of centres, mass-weighted; `snap` resolves fully at once (no velocity). */
function pair(a: Repeller, b: Repeller, contact: number, range: number, t: LiveTuning, unit: number, dt: number, snap: boolean): void {
	let dx = a.x - b.x;
	let dy = a.y - b.y;
	let d = Math.hypot(dx, dy);
	if (d >= range) return;
	if (d < EPS) {
		dx = Math.cos(a.ang);
		dy = Math.sin(a.ang);
		d = 0;
	} else {
		dx /= d;
		dy /= d;
	}
	const ia = 1 / a.mass;
	const ib = 1 / b.mass;
	const wa = ia / (ia + ib);
	const wb = 1 - wa;
	if (d < contact) {
		const pen = contact - d + (snap ? EPS : contact * 0.02);
		const f = snap ? 1 : 0.4;
		move(a, dx * pen * f * wa, dy * pen * f * wa);
		move(b, -dx * pen * f * wb, -dy * pen * f * wb);
		if (snap) return;
		const vn = (a.rvx - b.rvx) * dx + (a.rvy - b.rvy) * dy;
		if (vn < 0) {
			const j = (-(1 + t.restitution) * vn) / (ia + ib);
			a.rvx += dx * j * ia;
			a.rvy += dy * j * ia;
			b.rvx -= dx * j * ib;
			b.rvy -= dy * j * ib;
		}
	}
	if (snap) return;
	// The longer-range breathing-room push: full at contact, zero at `range`.
	const s = 1 - Math.max(0, d - contact) / (range - contact);
	const acc = t.repelPush * unit * s * s * dt;
	// Force-based, so the lighter body is accelerated more: a = F / m (F scaled so a sub-agent of mass massSub gets the full push).
	a.rvx += dx * acc * ia * t.massSub;
	a.rvy += dy * acc * ia * t.massSub;
	b.rvx -= dx * acc * ib * t.massSub;
	b.rvy -= dy * acc * ib * t.massSub;
}

/** Keep a badge clear of its KB node (an immovable circle). */
function clearNode(b: Repeller, minD: number, t: LiveTuning, snap: boolean): void {
	let dx = b.x - b.nx;
	let dy = b.y - b.ny;
	let d = Math.hypot(dx, dy);
	if (d >= minD) return;
	if (d < EPS) {
		dx = Math.cos(b.ang);
		dy = Math.sin(b.ang);
		d = 0;
	} else {
		dx /= d;
		dy /= d;
	}
	move(b, dx * (minD - d + (snap ? EPS : 0)), dy * (minD - d + (snap ? EPS : 0)));
	if (snap) return;
	const vn = b.rvx * dx + b.rvy * dy;
	if (vn < 0) {
		b.rvx -= dx * (1 + t.restitution) * vn;
		b.rvy -= dy * (1 + t.restitution) * vn;
	}
}

/**
 * One step of `n` bodies (`dt` seconds; `unit` = world units per screen px, `gap` and the push scale with it). Updates every body's x, y
 * and offset and velocity in place. `reduced`: overlaps are resolved by snapping positions in the call (no bounce, no velocity).
 */
export function repelStep(bodies: Repeller[], n: number, t: LiveTuning, unit: number, dtIn: number, reduced: boolean): void {
	const nodeGap = t.parkGapPx * unit;
	const dt = Math.min(Math.max(dtIn, 0), 0.05);
	const gap = t.repelGapPx * unit;
	if (!reduced) {
		const damp = Math.exp(-t.repelDamping * dt);
		const cap = t.maxWolfSpeedPx * unit;
		for (let i = 0; i < n; i++) {
			const b = bodies[i]!;
			b.rvx = (b.rvx - b.relax * b.rx * dt) * damp;
			b.rvy = (b.rvy - b.relax * b.ry * dt) * damp;
			const sp = Math.hypot(b.rvx, b.rvy);
			if (sp > cap) {
				b.rvx *= cap / sp;
				b.rvy *= cap / sp;
			}
		}
	}
	for (let pass = reduced ? 12 : 1; pass > 0; pass--) {
		for (let i = 0; i < n; i++) {
			const a = bodies[i]!;
			for (let j = i + 1; j < n; j++) {
				const c = bodies[j]!;
				if (a.grp >= 0 && a.grp === c.grp) continue;
				const contact = a.r + c.r + gap;
				pair(a, c, contact, contact * t.repelRangeMul, t, unit, dt, reduced);
			}
			if (a.nr > 0) clearNode(a, a.nr + a.r + nodeGap, t, reduced);
		}
		for (let i = 0; i < n; i++) if (bodies[i]!.maxOff < Number.POSITIVE_INFINITY) capOffset(bodies[i]!);
	}
	if (reduced) return;
	for (let i = 0; i < n; i++) {
		const b = bodies[i]!;
		move(b, b.rvx * dt, b.rvy * dt);
		if (b.maxOff < Number.POSITIVE_INFINITY) capOffset(b);
	}
}
