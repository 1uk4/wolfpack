/**
 * SUBAGENT PHYSICS (pure): a spring-damper per subagent body. A strong spring to its current target (decays over a few seconds) and a
 * tether spring to its feature hub: very weak while it works (targets win), strong once it has had no target for a while or has finished
 * (it reels back over a few seconds). Damped and speed-clamped, so it never explodes.
 */
export interface SubBody {
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** The current pull (world) and when it was set (ms). */
	tug?: { x: number; y: number; at: number };
	/** Collision radius (world). Absent = a point, ignored by `separateSubs`. */
	r?: number;
	/** Parent key: bodies of different parents never collide (they live around different hubs), which also keeps the pair loop cheap. */
	pk?: string;
	/** Its parent hub (or wolf): position and collision radius (world). `hr` > 0 turns the hub repulsion on. */
	hx?: number;
	hy?: number;
	hr?: number;
}
export interface SubPhysics {
	/** Spring toward the target at age 0 (per s²) and its e-fold decay (ms). */
	spring: number;
	decayMs: number;
	/** Tether stiffness while working and when idle/finished (per s²). */
	tetherWorking: number;
	tetherIdle: number;
	/** A finished subagent flies home on this one. */
	tetherFinished: number;
	/** No target for this long (ms): the tether ramps up from working to idle over `rampMs`. */
	idleMs: number;
	rampMs: number;
	/** Velocity kept per second (0..1) and speed limit (world units / s at zoom 1). */
	damping: number;
	maxSpeed: number;
}
export const SUB_PHYSICS: SubPhysics = { spring: 14, decayMs: 4500, tetherWorking: 0.12, tetherIdle: 1.4, tetherFinished: 6, idleMs: 10_000, rampMs: 3000, damping: 0.02, maxSpeed: 450 };

/** Repulsion between sub-agent bodies and from their hub: overlap (world) turns into a velocity push at this rate (per s). */
export const SUB_SEP_RATE = 14;
/** Bodies keep this fraction of the smaller radius as clear air between them. */
export const SUB_SEP_GAP = 0.4;

/**
 * Push overlapping bodies apart (pure, allocation-free): every pair closer than r1 + r2 + gap, and every body closer to its hub than
 * hr + r + gap, gets a velocity impulse along the line between them proportional to the overlap. Exactly coincident bodies split on a
 * fixed axis, so the result is deterministic. Pairs are O(n²) over the live sub-agents (a handful); bodies with different `pk` are skipped. Call before `stepSub` so the impulse is integrated with the rest.
 */
export function separateSubs(list: readonly SubBody[], dtSec: number, rate = SUB_SEP_RATE): void {
	const dt = Math.min(Math.max(dtSec, 0), 0.05);
	for (let i = 0; i < list.length; i++) {
		const a = list[i]!;
		if (a.r === undefined) continue;
		for (let j = i + 1; j < list.length; j++) {
			const b = list[j]!;
			if (b.r === undefined || (a.pk !== undefined && b.pk !== undefined && a.pk !== b.pk)) continue;
			let dx = b.x - a.x;
			let dy = b.y - a.y;
			let d = Math.hypot(dx, dy);
			const min = a.r + b.r + SUB_SEP_GAP * Math.min(a.r, b.r);
			if (d >= min) continue;
			if (d < 1e-6) {
				dx = 1;
				dy = 0;
				d = 1;
			}
			const push = ((min - d) * rate * dt) / d;
			a.vx -= dx * push * 0.5;
			a.vy -= dy * push * 0.5;
			b.vx += dx * push * 0.5;
			b.vy += dy * push * 0.5;
		}
		if (a.hr !== undefined && a.hr > 0 && a.hx !== undefined && a.hy !== undefined) {
			let dx = a.x - a.hx;
			let dy = a.y - a.hy;
			let d = Math.hypot(dx, dy);
			const min = a.hr + a.r + SUB_SEP_GAP * a.r;
			if (d >= min) continue;
			if (d < 1e-6) {
				dx = 1;
				dy = 0;
				d = 1;
			}
			const push = ((min - d) * rate * dt) / d;
			a.vx += dx * push;
			a.vy += dy * push;
		}
	}
}

/** Tether stiffness for a body whose last pull was `idleFor` ms ago (or a finished one). */
export function tetherStrength(p: SubPhysics, idleFor: number, finished: boolean): number {
	if (finished) return p.tetherFinished;
	const r = Math.min(1, Math.max(0, (idleFor - p.idleMs) / p.rampMs));
	return p.tetherWorking + (p.tetherIdle - p.tetherWorking) * r;
}

/** Advance one subagent body by `dtSec` (clamped to 0.05) toward its tug and its anchor. The speed limit is divided by `zoom`. */
export function stepSub(b: SubBody, now: number, dtSec: number, ax: number, ay: number, tether: number, zoom = 1, p: SubPhysics = SUB_PHYSICS): void {
	const dt = Math.min(Math.max(dtSec, 0), 0.05);
	let fx = (ax - b.x) * tether;
	let fy = (ay - b.y) * tether;
	if (b.tug) {
		const k = p.spring * Math.exp(-Math.max(0, now - b.tug.at) / p.decayMs);
		fx += (b.tug.x - b.x) * k;
		fy += (b.tug.y - b.y) * k;
	}
	const keep = Math.pow(p.damping, dt);
	let vx = (b.vx + fx * dt) * keep;
	let vy = (b.vy + fy * dt) * keep;
	const sp = Math.hypot(vx, vy);
	const max = p.maxSpeed / Math.max(zoom, 0.2);
	if (sp > max) {
		vx = (vx / sp) * max;
		vy = (vy / sp) * max;
	}
	b.vx = vx;
	b.vy = vy;
	b.x += vx * dt;
	b.y += vy * dt;
}
