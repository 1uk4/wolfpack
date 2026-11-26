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
