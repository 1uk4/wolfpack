/**
 * FEATURE RINGS (pure): a feature thread is a wolf icon inside a hollow ring (the thread); its running sub-agents sit evenly spaced on
 * the ring. Trails start at the actor that made them; each actor pulls with its own strength (the table in live-tuning.ts); a sub-agent
 * stretches out on an elastic tether and snaps back. Work-wolfpack-1Djd6IR.
 */
import type { LiveTuning } from "./live-tuning";

export interface Pt { x: number; y: number }

/** `n` points evenly spaced on a circle of `radius` about `centre`, the first at angle `rot` (radians). */
export function ringSlots(centre: Pt, radius: number, n: number, rot: number): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i < n; i++) {
		const a = rot + (Math.PI * 2 * i) / n;
		out.push({ x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius });
	}
	return out;
}

/** The angle (radians) the whole ring of sub-agents has turned by at wall time `wallMs`: one revolution per `orbitSec`; reduced motion: none (static even slots). */
export function orbitPhase(wallMs: number, orbitSec: number, reduced: boolean): number {
	if (reduced || !(orbitSec > 0)) return 0;
	return (((wallMs / 1000) % orbitSec) / orbitSec) * Math.PI * 2;
}

/** Where an interaction's trail begins: the group's centre for the thread's own chat, the sub-agent's icon for a sub-agent. */
export function trailOrigin(actor: "chat" | "sub", centre: Pt, icon: Pt | undefined): Pt {
	return actor === "sub" && icon ? icon : centre;
}

export interface Pull { x: number; y: number; holdSec: number }
/**
 * The pull of one interaction, as offsets (world) from rest. `group` moves the whole feature group from its home; `self` (sub-agent only)
 * moves the sub-agent from where its icon is. Chat: the group goes pull x reach of the way. Sub-agent: it stretches pull x stretch of the
 * way and the group only drifts a few percent.
 */
export function pullFor(actor: "chat" | "sub", home: Pt, icon: Pt, target: Pt, t: LiveTuning): { group: Pull; self?: Pull } {
	const pace = t.paceSec;
	if (actor === "chat") {
		const f = t.chatPull * t.chatReach;
		return { group: { x: (target.x - home.x) * f, y: (target.y - home.y) * f, holdSec: pace * t.chatHoldMul } };
	}
	const g = t.subPull * t.subGroupDrift;
	const s = t.subPull * t.subStretch;
	return {
		group: { x: (target.x - home.x) * g, y: (target.y - home.y) * g, holdSec: pace * t.subGroupHoldMul },
		self: { x: (target.x - icon.x) * s, y: (target.y - icon.y) * s, holdSec: pace * t.subHoldMul },
	};
}

export interface Elastic { x: number; y: number; vx: number; vy: number }
/** One step (dt s, clamped) of a damped spring of rate `w` (1/s) and damping `zeta` (friction = zeta x w, as the concept) toward (gx, gy): the tether that stretches and snaps back. */
export function elasticStep(b: Elastic, gx: number, gy: number, w: number, zeta: number, dtSec: number): void {
	const dt = Math.min(Math.max(dtSec, 0), 0.05);
	b.vx += (w * w * (gx - b.x) - zeta * w * b.vx) * dt;
	b.vy += (w * w * (gy - b.y) - zeta * w * b.vy) * dt;
	b.x += b.vx * dt;
	b.y += b.vy * dt;
}
