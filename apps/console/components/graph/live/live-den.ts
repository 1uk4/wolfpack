/**
 * THE WOLF STATE MACHINE (pure): resting -> working -> lingering -> returning -> resting (work-wolfpack-LX5JYDd, concept frames/polish p-den).
 * An event sends the wolf along waypoints (den -> domain nodes -> target: along connections, not a straight line) at the pace; it settles
 * at the target (lingering, the den tether strengthening). It goes home `returnAfterEventSec` after its last event, or `returnAfterIdleSec`
 * after its thread went idle; never while it has a needs-you question. Times are wall ms, motion is dt seconds.
 */
import type { LiveTuning } from "./live-tuning";

export interface Pt { x: number; y: number }
export type WolfPhase = "resting" | "working" | "lingering" | "returning";
export interface WolfMotion {
	phase: WolfPhase;
	x: number;
	y: number;
	path: Pt[];
	len: number;
	pr: number;
	/** Waypoints back to the den (the trip's, reversed, without the target). */
	back: Pt[];
	lastEventAt: number;
	/** When the wolf's threads and subagents went idle (null while any is working). */
	idleSince: number | null;
	arrivedAt?: number;
}
export interface WolfCtx {
	den: Pt;
	/** The wolf's resting slot now (moves with the orbit). */
	rest: Pt;
	needsYou: boolean;
	/** Any thread active or subagent running. */
	working: boolean;
	reduced: boolean;
	tuning: LiveTuning;
}

export const newMotion = (x: number, y: number): WolfMotion => ({ phase: "resting", x, y, path: [], len: 0, pr: 0, back: [], lastEventAt: 0, idleSince: null });

const lengthOf = (p: readonly Pt[]): number => {
	let s = 0;
	for (let i = 1; i < p.length; i++) s += Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y);
	return s;
};
function pointAt(p: readonly Pt[], d: number, out: Pt): Pt {
	for (let i = 1; i < p.length; i++) {
		const l = Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y);
		if (d <= l || i === p.length - 1) {
			const f = l > 0 ? Math.min(1, d / l) : 1;
			out.x = p[i - 1]!.x + (p[i]!.x - p[i - 1]!.x) * f;
			out.y = p[i - 1]!.y + (p[i]!.y - p[i - 1]!.y) * f;
			return out;
		}
		d -= l;
	}
	out.x = p[0]!.x;
	out.y = p[0]!.y;
	return out;
}
const smoother = (e: number): number => e * e * e * (e * (e * 6 - 15) + 10);

/** An event: travel from where the wolf is along `via` (the last point is the target); the clocks restart. */
export function wolfEvent(m: WolfMotion, now: number, via: readonly Pt[]): void {
	if (via.length === 0) return;
	m.path = [{ x: m.x, y: m.y }, ...via];
	m.len = lengthOf(m.path);
	m.pr = 0;
	m.back = via.slice(0, -1).reverse();
	m.lastEventAt = now;
	m.idleSince = null;
	m.arrivedAt = undefined;
	m.phase = "working";
}

/** Seconds into the den tether ramp: 0 unless lingering, 1 after `lingerRampSec`. */
export function tetherStrength(m: WolfMotion, now: number, t: LiveTuning): number {
	if (m.phase !== "lingering" || m.arrivedAt === undefined) return 0;
	return Math.min(1, Math.max(0, (now - m.arrivedAt) / (t.lingerRampSec * 1000)));
}

/** Where a resting wolf of `n` sits (index `i` in name order): evenly round the den, slowly orbiting, breathing; offline a little further out. `m` = world per ref px, `tSec` = clock. */
export function restSlot(i: number, n: number, tSec: number, online: boolean, den: Pt, m: number, t: LiveTuning, reduced = false): Pt {
	const a = -Math.PI / 2 + (Math.PI * 2 * i) / Math.max(1, n) + (reduced ? 0 : tSec * t.restOrbitRadPerSec * (online ? 1 : 0.5));
	const r = (t.restRadiusPx + (online ? 0 : t.restOfflineExtraPx) + (reduced ? 0 : t.restBreathPx * Math.sin(tSec * t.restBreathRadPerSec))) * m;
	return { x: den.x + Math.cos(a) * r, y: den.y + Math.sin(a) * r };
}

export interface OrbitWeights { homeSpring: number; threadPull: number; focusPull: number; subPull: number }
/**
 * THE FORCE MODEL (pure): the wolf's equilibrium round Home. Its rest slot (on the rest orbit) anchors a spring of weight `homeSpring`;
 * every active thread, focus node (KB entry / work item its home thread reads or writes) and own sub-agent pulls with its kind's weight.
 * The result is the weighted mean of rest and the pull points, so it always lies between them: the spring bounds how far a pull takes it.
 * Callers ease toward it (wolfStep) and snap to it under reduced motion.
 */
export function orbitTarget(rest: Pt, threads: readonly Pt[], focus: readonly Pt[], subs: readonly Pt[], w: OrbitWeights, _reduced: boolean): Pt {
	let fx = 0;
	let fy = 0;
	let sum = w.homeSpring;
	const add = (ps: readonly Pt[], k: number) => {
		for (const p of ps) {
			fx += k * (p.x - rest.x);
			fy += k * (p.y - rest.y);
			sum += k;
		}
	};
	add(threads, w.threadPull);
	add(focus, w.focusPull);
	add(subs, w.subPull);
	return { x: rest.x + fx / sum, y: rest.y + fy / sum };
}

/** Whether the return is due (never while a question waits). */
function returnDue(m: WolfMotion, now: number, c: WolfCtx): boolean {
	if (c.needsYou) return false;
	if (now >= m.lastEventAt + c.tuning.returnAfterEventSec * 1000) return true;
	return m.idleSince !== null && now >= m.idleSince + c.tuning.returnAfterIdleSec * 1000;
}

const tmp: Pt = { x: 0, y: 0 };
/** Advance one frame. Mutates `m` (x, y, phase). */
export function wolfStep(m: WolfMotion, now: number, dtSec: number, c: WolfCtx): void {
	const dt = Math.min(Math.max(dtSec, 0), 0.25);
	if (c.working) m.idleSince = null;
	else if (m.idleSince === null) m.idleSince = now;
	if (m.phase === "working" || m.phase === "returning") {
		const speedCap = c.tuning.maxWolfSpeedPx / 1.875; // the eased path peaks at 1.875x its mean speed
		m.pr += c.reduced ? 1 : dt * Math.min(1 / c.tuning.paceSec, speedCap / Math.max(m.len, 1));
		const e = Math.min(1, m.pr);
		pointAt(m.path, smoother(e) * m.len, tmp);
		m.x = tmp.x;
		m.y = tmp.y;
		if (e >= 1) {
			if (m.phase === "working") {
				m.phase = "lingering";
				m.arrivedAt = now;
			} else m.phase = "resting";
		}
		return;
	}
	if (m.phase === "lingering") {
		if (returnDue(m, now, c)) {
			m.path = [{ x: m.x, y: m.y }, ...m.back, c.den];
			m.len = lengthOf(m.path);
			m.pr = 0;
			m.phase = "returning";
			m.arrivedAt = undefined;
		}
		return;
	}
	const k = c.reduced ? 1 : Math.min(1, dt * 0.6);
	m.x += (c.rest.x - m.x) * k;
	m.y += (c.rest.y - m.y) * k;
}
