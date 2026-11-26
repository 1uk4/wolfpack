/**
 * LIVE WOLF PHYSICS (pure): a tiny parallel simulation for the wolf nodes. It only READS graph node positions (targets, home centroids)
 * and never writes them, so the KB layout can't jump or re-heat when wolves move.
 *
 * Forces per step: a spring toward the last event target whose strength decays over a few seconds (after that the wolf drifts), a weak
 * pull toward the home-domain centroid, pairwise repulsion between wolves, velocity damping and a speed clamp.
 */
export interface WolfBody {
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Current pull target (world) and when it was set (ms); absent = drifting. */
	tug?: { x: number; y: number; at: number };
	/** Home-domain centroid (world), when known. */
	home?: { x: number; y: number };
}

export interface PhysicsParams {
	/** Spring stiffness toward the tug target at age 0 (per s²). */
	spring: number;
	/** The spring's strength falls by e every this many ms. */
	decayMs: number;
	/** Weak pull toward home (per s²). */
	homePull: number;
	/** Wolf-wolf repulsion strength, and its reach (world units). */
	repel: number;
	repelRange: number;
	/** Velocity kept per second (0..1). */
	damping: number;
	/** Speed limit (world units / s). */
	maxSpeed: number;
}
export const DEFAULT_PHYSICS: PhysicsParams = { spring: 6, decayMs: 2500, homePull: 0.35, repel: 9000, repelRange: 140, damping: 0.25, maxSpeed: 220 };

/** Spring strength at `age` ms after the tug: decays exponentially to ~0 after a few seconds. */
export function springStrength(p: PhysicsParams, ageMs: number): number {
	return p.spring * Math.exp(-Math.max(0, ageMs) / p.decayMs);
}

/** Advance every body by `dtSec` (clamped to 0.05). Mutates and returns `bodies`. */
export function stepWolves(bodies: WolfBody[], now: number, dtSec: number, p: PhysicsParams = DEFAULT_PHYSICS): WolfBody[] {
	const dt = Math.min(Math.max(dtSec, 0), 0.05);
	for (let i = 0; i < bodies.length; i++) {
		const a = bodies[i]!;
		let fx = 0;
		let fy = 0;
		if (a.tug) {
			const k = springStrength(p, now - a.tug.at);
			fx += (a.tug.x - a.x) * k;
			fy += (a.tug.y - a.y) * k;
		}
		if (a.home) {
			fx += (a.home.x - a.x) * p.homePull;
			fy += (a.home.y - a.y) * p.homePull;
		}
		for (let j = 0; j < bodies.length; j++) {
			if (i === j) continue;
			const b = bodies[j]!;
			let dx = a.x - b.x;
			let dy = a.y - b.y;
			let d2 = dx * dx + dy * dy;
			if (d2 < 1e-6) {
				// Coincident: nudge apart deterministically by index.
				dx = i < j ? 1 : -1;
				dy = 0.5;
				d2 = dx * dx + dy * dy;
			}
			const d = Math.sqrt(d2);
			if (d > p.repelRange) continue;
			const f = (p.repel / d2) * (1 - d / p.repelRange);
			fx += (dx / d) * f;
			fy += (dy / d) * f;
		}
		const keep = Math.pow(p.damping, dt);
		let vx = (a.vx + fx * dt) * keep;
		let vy = (a.vy + fy * dt) * keep;
		const sp = Math.hypot(vx, vy);
		if (sp > p.maxSpeed) {
			vx = (vx / sp) * p.maxSpeed;
			vy = (vy / sp) * p.maxSpeed;
		}
		a.vx = vx;
		a.vy = vy;
	}
	for (const a of bodies) {
		a.x += a.vx * dt;
		a.y += a.vy * dt;
	}
	return bodies;
}

/** True while any body still moves noticeably or is still being pulled (the caller keeps the animation loop running). */
export function wolvesMoving(bodies: readonly WolfBody[], now: number, p: PhysicsParams = DEFAULT_PHYSICS): boolean {
	return bodies.some((b) => Math.hypot(b.vx, b.vy) > 0.4 || (b.tug !== undefined && springStrength(p, now - b.tug.at) > 0.05));
}
