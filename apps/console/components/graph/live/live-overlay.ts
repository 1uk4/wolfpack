/**
 * The live overlay controller: owns the LiveState (src/core/graph/live), the wolf bodies (a PARALLEL lightweight sim that only reads graph
 * node positions, so KB nodes never move because of wolves), the satellite layout, drawing through the effect registry, and hit-testing.
 * The renderer (graph-canvas.ts) calls `step` and `draw` from its own rAF tick and asks `needsFrames()` whether to keep the loop alive.
 */
import {
	DEFAULT_LIVE_OPTIONS,
	emptyLiveState,
	homeDomainOf,
	liveActive,
	liveSignature,
	reduceLive,
	subagentAlpha,
	trailAlpha,
	visibleThreads,
	type LiveAction,
	type LiveOptions,
	type LiveState,
	type LiveTarget,
} from "@/src/core/graph/live/live-state";
import { ownerThreadKey, targetNodeId, threadSlugOf } from "@/src/core/graph/live/live-targets";
import { DEFAULT_PHYSICS, stepWolves, wolvesMoving, type WolfBody } from "@/src/core/graph/live/live-physics";
import { AMBER, EFFECTS, rgba } from "./live-effects";
import { redact } from "@/src/core/graph/privacy";

export interface Pt { x: number; y: number }
export interface OverlayHost {
	nodePos(id: string): Pt | null;
	hasNode(id: string): boolean;
	nodeColor(id: string): string | undefined;
	center(): Pt;
	colors: { node: string; edge: string; label: string; hoverText: string };
	fontFamily: string;
}
export interface OverlaySettings { enabled: boolean; intensity: number; trailSec: number; subagentFadeSec: number }
export const LIVE_DEFAULTS: OverlaySettings = { enabled: true, intensity: 1, trailSec: 15, subagentFadeSec: 15 };

/** `settings.live ?? defaults`, typed loosely so it works before and after the settings panel gains the field. */
export function liveSettingsOf(settings: unknown): OverlaySettings {
	const l = (settings as { live?: Partial<OverlaySettings> } | null | undefined)?.live ?? {};
	const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
	return {
		enabled: typeof l.enabled === "boolean" ? l.enabled : LIVE_DEFAULTS.enabled,
		intensity: num(l.intensity, LIVE_DEFAULTS.intensity, 1, 5),
		trailSec: num(l.trailSec, LIVE_DEFAULTS.trailSec, 0, 300),
		subagentFadeSec: num(l.subagentFadeSec, LIVE_DEFAULTS.subagentFadeSec, 0, 300),
	};
}

export type OverlayKind = "wolf" | "thread" | "subagent" | "you";
export interface OverlayItem {
	kind: OverlayKind;
	key: string;
	wolf: string;
	threadId?: string;
	x: number;
	y: number;
	/** World radius. */
	r: number;
	alpha: number;
	needsYou: boolean;
	online: boolean;
	color: string;
	label: string;
}
export interface OverlayHit { item: OverlayItem; ring: boolean; sx: number; sy: number }
export interface OverlayCard {
	title: string;
	lines: string[];
	/** What a click/tap on the card's button does. */
	action?: { kind: "open-thread" | "open-work" | "answer"; label: string; wolf: string; threadId?: string; workId?: string };
}
export interface AttachedRef { wolf: string; threadId: string }
/** What the activity feed asks the overlay to ring: a graph node id, an event target (resolved like a trail), or a wolf's glyph. */
export interface OverlayHighlight { nodeId?: string; target?: LiveTarget; wolf?: string }

const hash = (s: string) => {
	let h = 7;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return Math.abs(h);
};

const TUG_STALE_MS = 3000;
const RING_FRAME_MS = 125;

export class LiveOverlay {
	private state: LiveState = emptyLiveState(Date.now());
	private bodies = new Map<string, WolfBody & { offline?: boolean }>();
	/** A target a wolf should drift to; dropped after TUG_STALE_MS if no frame consumed it (so it can never hold the frame loop). */
	private pendingTugs = new Map<string, { target: LiveTarget; at: number }>();
	/** Earliest time the next needs-you ring frame may be drawn (the ring pulses slowly, about 8 fps). */
	private nextFrameAt = 0;
	private ringTimer: ReturnType<typeof setTimeout> | null = null;
	private trailFrom = new Map<string, Pt>();
	private you: Pt | null = null;
	private attached: AttachedRef | null = null;
	private highlight: OverlayHighlight | null = null;
	private settings: OverlaySettings = LIVE_DEFAULTS;
	private timer: ReturnType<typeof setInterval> | null = null;
	readonly mobile: boolean;
	/** Read live, so a change of the OS setting applies without a reload. */
	get reduced(): boolean {
		return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	}

	constructor(private readonly requestFrame: () => void) {
		const mq = (q: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches;
		this.mobile = mq("(pointer: coarse)") || (typeof window !== "undefined" && window.innerWidth < 700);
	}

	/** About 30 fps on phones. */
	get minFrameMs(): number {
		return this.mobile ? 33 : 0;
	}
	get enabled(): boolean {
		return this.settings.enabled;
	}

	private liveOpts(): LiveOptions {
		return { ...DEFAULT_LIVE_OPTIONS, subagentFadeSec: this.settings.subagentFadeSec, trailSec: this.settings.trailSec, maxTrails: this.mobile ? 100 : 200 };
	}

	private privateView = false;
	/** Private view: hover and pin cards show kind and wolf only (work-wolfpack-xH0rRtw). */
	setPrivate(on: boolean): void {
		this.privateView = on;
		this.requestFrame();
	}

	configure(s: OverlaySettings): void {
		const was = this.settings.enabled;
		this.settings = s;
		if (!s.enabled && was) {
			this.state = emptyLiveState(Date.now());
			this.bodies.clear();
		}
		this.requestFrame();
	}

	/** Draw a soft ring on a node / target / wolf (the activity feed's hover). `null` clears it. */
	setHighlight(h: OverlayHighlight | null): void {
		this.highlight = h;
		this.requestFrame();
	}

	setAttached(ref: AttachedRef | null): void {
		this.attached = ref;
		this.requestFrame();
	}

	/** Start from an already-reduced state (the shared feed was running before this graph mounted). */
	loadState(s: LiveState): void {
		if (this.settings.enabled && Object.keys(s.wolves).length > 0) this.state = s;
		this.arm();
		this.requestFrame();
	}

	dispatch(a: LiveAction): void {
		if (!this.settings.enabled) return;
		const sigBefore = liveSignature(this.state);
		const next = reduceLive(this.state, a, this.liveOpts());
		if (next === this.state) return; // nothing changed: no frame
		this.state = next;
		if (a.type === "event" && a.event.target && a.event.actor.wolf && ["kb-read", "kb-write", "contribution", "shipped", "bound"].includes(a.event.verb)) {
			this.pendingTugs.set(a.event.actor.wolf, { target: { kind: a.event.target.kind, id: a.event.target.id, domain: a.event.target.domain ?? a.event.domain }, at: Date.now() });
		}
		this.arm();
		if (a.type !== "tick" || liveSignature(next) !== sigBefore) this.requestFrame();
	}

	/** Start the 1 s housekeeping clock (expiry); paused while the tab is hidden. */
	start(): void {
		this.started = true;
		this.arm();
	}
	private started = false;
	/** The clock runs only while something can expire; with no live data there is no timer at all. */
	private arm(): void {
		if (!this.started || this.timer || !this.settings.enabled || !liveActive(this.state)) return;
		this.timer = setInterval(() => {
			if (typeof document !== "undefined" && document.hidden) return;
			this.dispatch({ type: "tick", now: Date.now() });
			if (!liveActive(this.state) && this.timer) {
				clearInterval(this.timer);
				this.timer = null;
			}
		}, 1000);
	}
	stop(): void {
		this.started = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.ringTimer) clearTimeout(this.ringTimer);
		this.ringTimer = null;
	}

	/** Anything left to animate (the renderer keeps its rAF loop alive only while this is true). */
	needsFrames(now: number): boolean {
		if (!this.settings.enabled) return false;
		if (this.reduced) return false;
		const s = this.state;
		if (this.highlight) return true;
		const wall = Date.now();
		if (s.pulses.length > 0) return true;
		// Trails keep frames coming only while they are still visibly fading.
		if (s.trails.some((t) => this.trailFrom.has(t.id) && trailAlpha(t, wall, this.settings.trailSec) > 0)) return true;
		if ([...this.pendingTugs.values()].some((p) => wall - p.at < TUG_STALE_MS)) return true;
		if (Object.values(s.subagents).some((a) => a.finishedAt !== undefined && subagentAlpha(a, wall, this.settings.subagentFadeSec) > 0.02)) return true;
		if (wolvesMoving([...this.bodies.values()], now) || this.youMoving) return true;
		// A needs-you ring alone does not hold the rAF loop: it asks for a frame itself at about 8 fps.
		if (Object.values(s.wolves).some((w) => w.needsYou) && !this.ringTimer) {
			this.ringTimer = setTimeout(() => {
				this.ringTimer = null;
				this.nextFrameAt = Date.now() + RING_FRAME_MS;
				this.requestFrame();
			}, Math.max(0, this.nextFrameAt - Date.now()));
		}
		return false;
	}
	private youMoving = false;

	get hasAnything(): boolean {
		return this.settings.enabled && Object.keys(this.state.wolves).length > 0;
	}

	// ── physics + layout ──

	step(now: number, dtSec: number, host: OverlayHost, k: number): void {
		if (!this.settings.enabled) return;
		const s = this.state;
		const bodies: (WolfBody & { offline?: boolean })[] = [];
		for (const w of Object.values(s.wolves)) {
			const dom = homeDomainOf(w, w.name);
			const homePt = (dom ? host.nodePos(`dom:${dom}`) : null) ?? host.center();
			const jitter = hash(w.name);
			const ang = (jitter % 360) * (Math.PI / 180);
			const home = { x: homePt.x + Math.cos(ang) * 36 / k, y: homePt.y + Math.sin(ang) * 36 / k };
			let b = this.bodies.get(w.name);
			if (!b) {
				b = { x: home.x, y: home.y, vx: 0, vy: 0 };
				this.bodies.set(w.name, b);
			}
			b.home = home;
			const off = !w.online;
			if (off && !b.offline) b.tug = { x: home.x, y: home.y, at: now };
			b.offline = off;
			const tgt = this.pendingTugs.get(w.name)?.target;
			if (tgt && !off) {
				const id = targetNodeId(tgt, (n) => host.hasNode(n));
				const p = id ? host.nodePos(id) : null;
				if (p) b.tug = { x: p.x + 16 / k, y: p.y - 16 / k, at: now };
			}
			this.pendingTugs.delete(w.name);
			bodies.push(b);
		}
		for (const name of [...this.bodies.keys()]) if (!s.wolves[name]) this.bodies.delete(name);
		if (this.reduced) {
			for (const b of bodies) {
				const t = b.tug ?? b.home;
				if (t) [b.x, b.y, b.vx, b.vy] = [t.x, t.y, 0, 0];
			}
		} else {
			stepWolves(bodies, now, dtSec, { ...DEFAULT_PHYSICS, repelRange: DEFAULT_PHYSICS.repelRange / Math.max(k, 0.2) ** 0.5, maxSpeed: DEFAULT_PHYSICS.maxSpeed / Math.max(k, 0.2) });
		}
		// Trails remember where the wolf WAS when the line began.
		for (const t of s.trails) {
			if (this.trailFrom.has(t.id)) continue;
			const b = this.bodies.get(t.wolf);
			if (b) this.trailFrom.set(t.id, { x: b.x, y: b.y });
		}
		if (this.trailFrom.size > s.trails.length + 50) {
			const live = new Set(s.trails.map((t) => t.id));
			for (const id of this.trailFrom.keys()) if (!live.has(id)) this.trailFrom.delete(id);
		}
		// The "you" node eases toward what you are looking at.
		const want = this.youTarget(host, k);
		if (want) {
			if (!this.you || this.reduced) this.you = { ...want };
			else {
				const f = 1 - Math.exp(-dtSec * 6);
				this.you = { x: this.you.x + (want.x - this.you.x) * f, y: this.you.y + (want.y - this.you.y) * f };
			}
			this.youMoving = !this.reduced && Math.hypot(want.x - this.you.x, want.y - this.you.y) * k > 0.5;
		} else {
			this.you = null;
			this.youMoving = false;
		}
	}

	/** Where the you-node wants to sit: next to what you are viewing, else next to the floating chat's thread. */
	private youTarget(host: OverlayHost, k: number): Pt | null {
		const link = this.youLinks(host)[0];
		return link ? { x: link.x - 22 / k, y: link.y - 22 / k } : null;
	}

	/** Points the you-node is linked to: the viewed thread / item first, then the floating chat's attached thread. */
	private youLinks(host: OverlayHost): Pt[] {
		const out: Pt[] = [];
		const items = this.cachedItems;
		const s = this.state;
		const v = s.owner?.viewing;
		if (v) {
			if (v.kind === "thread") {
				const key = ownerThreadKey(s);
				const t = key ? s.threads[key] : null;
				const it = t ? items.find((i) => i.kind === "thread" && i.key === `${t.wolf}/${t.id}`) : null;
				if (it) out.push({ x: it.x, y: it.y });
			} else {
				const id = targetNodeId(v, (n) => host.hasNode(n));
				const p = id ? host.nodePos(id) : null;
				if (p) out.push(p);
			}
		}
		if (this.attached) {
			const a = this.attached;
			const it = items.find((i) => i.kind === "thread" && i.wolf === a.wolf && threadSlugOf(a.wolf, i.threadId ?? "") === threadSlugOf(a.wolf, a.threadId));
			const wb = items.find((i) => i.kind === "wolf" && i.wolf === a.wolf);
			const p = it ?? wb;
			if (p) out.push({ x: p.x, y: p.y });
		}
		return out;
	}

	private cachedItems: OverlayItem[] = [];

	/** Wolves, thread satellites and subagent satellites at their current positions (world). */
	items(host: OverlayHost, k: number, now: number): OverlayItem[] {
		const s = this.state;
		const out: OverlayItem[] = [];
		const threads = visibleThreads(s);
		for (const w of Object.values(s.wolves)) {
			const b = this.bodies.get(w.name);
			if (!b) continue;
			const dom = homeDomainOf(w, w.name);
			const color = (dom && host.nodeColor(`dom:${dom}`)) || host.colors.node;
			out.push({ kind: "wolf", key: w.name, wolf: w.name, x: b.x, y: b.y, r: 7 / k, alpha: w.online ? 1 : 0.35, needsYou: w.needsYou, online: w.online, color, label: w.name });
			const mine = threads.filter((t) => t.wolf === w.name).sort((a, c) => (a.id < c.id ? -1 : 1));
			mine.forEach((t, i) => {
				const ang = -Math.PI / 2 + (i - (mine.length - 1) / 2) * 0.75 + 0.35;
				const tx = b.x + Math.cos(ang) * 17 / k;
				const ty = b.y + Math.sin(ang) * 17 / k;
				out.push({ kind: "thread", key: `${t.wolf}/${t.id}`, wolf: t.wolf, threadId: t.id, x: tx, y: ty, r: 3.2 / k, alpha: t.active ? 0.95 : 0.55, needsYou: t.needsYou, online: w.online, color, label: t.title ?? threadSlugOf(t.wolf, t.id) });
				const subs = Object.values(s.subagents).filter((a) => a.wolf === t.wolf && a.parentThreadId === t.id);
				subs.forEach((a, j) => {
					const al = subagentAlpha(a, now, this.settings.subagentFadeSec);
					if (al <= 0.02) return;
					const sa = ang + (j - (subs.length - 1) / 2) * 0.9;
					out.push({ kind: "subagent", key: a.key, wolf: a.wolf, threadId: t.id, x: tx + Math.cos(sa) * 9 / k, y: ty + Math.sin(sa) * 9 / k, r: 2 / k, alpha: al, needsYou: false, online: w.online, color, label: a.title ?? a.name });
				});
			});
		}
		// Subagents whose parent thread is hidden or unknown hang off their wolf.
		for (const a of Object.values(s.subagents)) {
			if (out.some((i) => i.key === a.key)) continue;
			const b = this.bodies.get(a.wolf);
			const al = subagentAlpha(a, now, this.settings.subagentFadeSec);
			if (!b || al <= 0.02) continue;
			const ang = (hash(a.key) % 360) * (Math.PI / 180);
			out.push({ kind: "subagent", key: a.key, wolf: a.wolf, threadId: a.parentThreadId, x: b.x + Math.cos(ang) * 14 / k, y: b.y + Math.sin(ang) * 14 / k, r: 2 / k, alpha: al, needsYou: false, online: true, color: host.colors.node, label: a.title ?? a.name });
		}
		this.cachedItems = out;
		if (this.you) out.push({ kind: "you", key: "you", wolf: "", x: this.you.x, y: this.you.y, r: 6 / k, alpha: 1, needsYou: false, online: true, color: host.colors.hoverText, label: "You" });
		return out;
	}

	// ── drawing (world coordinates, camera already applied) ──

	draw(ctx: CanvasRenderingContext2D, host: OverlayHost, k: number, now: number): void {
		if (!this.settings.enabled || Object.keys(this.state.wolves).length === 0) return;
		const s = this.state;
		const I = this.settings.intensity;
		const reduced = this.reduced;
		const items = this.items(host, k, now);
		ctx.save();
		ctx.lineCap = "round";

		// Trails: the path the wolf took to the thing it touched, fading over trailSec.
		for (const t of s.trails) {
			const id = targetNodeId(t.target, (n) => host.hasNode(n));
			const to = id ? host.nodePos(id) : null;
			const from = this.trailFrom.get(t.id);
			if (!to || !from) continue;
			const age = 1 - trailAlpha(t, now, this.settings.trailSec);
			const w = items.find((i) => i.kind === "wolf" && i.wolf === t.wolf);
			EFFECTS.trail!({ ctx, x: from.x, y: from.y, toX: to.x, toY: to.y, r: 0, k, t: reduced ? Math.min(age, 0.6) : age, color: w?.color ?? host.colors.node, intensity: I, reduced });
		}
		// Pulses on the touched node.
		for (const p of s.pulses) {
			const id = targetNodeId(p.target, (n) => host.hasNode(n));
			const at = id ? host.nodePos(id) : null;
			if (!at) continue;
			const w = items.find((i) => i.kind === "wolf" && i.wolf === p.wolf);
			EFFECTS.pulse!({ ctx, x: at.x, y: at.y, r: 8 / k, k, t: Math.min(1, (now - p.at) / DEFAULT_LIVE_OPTIONS.pulseMs), color: w?.color ?? host.colors.node, intensity: I, reduced });
		}
		// Links: wolf -> its thread dots, thread -> bound work item (faint), subagent -> parent.
		ctx.lineWidth = 0.8 / k;
		for (const it of items) {
			if (it.kind === "thread") {
				const wolf = items.find((i) => i.kind === "wolf" && i.wolf === it.wolf);
				if (wolf) this.line(ctx, wolf, it, rgba(it.color, 0.25 * it.alpha));
				const t = s.threads[it.key];
				if (t?.bound) {
					const id = targetNodeId(t.bound, (n) => host.hasNode(n));
					const p = id ? host.nodePos(id) : null;
					if (p) {
						ctx.setLineDash([2 / k, 3 / k]);
						this.line(ctx, it, p, rgba(it.color, 0.28));
						ctx.setLineDash([]);
					}
				}
			} else if (it.kind === "subagent") {
				const parent = items.find((i) => i.kind === "thread" && i.wolf === it.wolf && i.threadId === it.threadId) ?? items.find((i) => i.kind === "wolf" && i.wolf === it.wolf);
				if (parent) this.line(ctx, parent, it, rgba(it.color, 0.2 * it.alpha));
			}
		}
		// The you-node's dashed links.
		const you = items.find((i) => i.kind === "you");
		if (you) {
			const links = this.youLinks(host);
			ctx.setLineDash([3 / k, 3 / k]);
			links.forEach((p, i) => this.line(ctx, you, p, rgba(host.colors.hoverText, i === 0 ? 0.45 : 0.22)));
			ctx.setLineDash([]);
		}
		// Glyphs.
		for (const it of items) {
			ctx.globalAlpha = it.alpha;
			if (it.kind === "wolf") {
				if (it.online) EFFECTS.glow!({ ctx, x: it.x, y: it.y, r: it.r, k, t: 0, color: it.color, intensity: I, reduced });
				ctx.beginPath();
				ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
				ctx.fillStyle = rgba(it.color, 0.22);
				ctx.fill();
				ctx.lineWidth = 1.3 / k;
				ctx.strokeStyle = rgba(it.color, 0.95);
				ctx.stroke();
				ctx.fillStyle = rgba(host.colors.label, 0.95);
				ctx.font = `600 ${8 / k}px ${host.fontFamily}`;
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(it.label.charAt(0).toUpperCase(), it.x, it.y + 0.3 / k);
			} else if (it.kind === "thread") {
				ctx.beginPath();
				ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
				ctx.fillStyle = rgba(it.color, 0.9);
				ctx.fill();
			} else if (it.kind === "subagent") {
				ctx.beginPath();
				ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
				ctx.fillStyle = rgba(host.colors.label, 0.75);
				ctx.fill();
			} else {
				// You: a small rounded diamond, distinct from the round wolves.
				ctx.save();
				ctx.translate(it.x, it.y);
				ctx.rotate(Math.PI / 4);
				const h = it.r * 0.8;
				ctx.beginPath();
				ctx.rect(-h, -h, h * 2, h * 2);
				ctx.fillStyle = rgba(host.colors.hoverText, 0.15);
				ctx.fill();
				ctx.lineWidth = 1.5 / k;
				ctx.strokeStyle = rgba(host.colors.hoverText, 0.9);
				ctx.stroke();
				ctx.restore();
			}
			ctx.globalAlpha = 1;
			if (it.needsYou && (it.kind === "wolf" || it.kind === "thread")) {
				EFFECTS.ring!({ ctx, x: it.x, y: it.y, r: it.r, k, t: 0, color: AMBER, intensity: I, reduced, time: now, alpha: it.alpha });
			}
		}
		const hl = this.highlight;
		if (hl) {
			let at: Pt | null = null;
			let r = 9 / k;
			let color = host.colors.hoverText;
			if (hl.wolf) {
				const it = items.find((i) => i.kind === "wolf" && i.wolf === hl.wolf);
				if (it) [at, r, color] = [it, it.r + 4 / k, it.color];
			}
			if (!at) {
				const id = hl.nodeId && host.hasNode(hl.nodeId) ? hl.nodeId : hl.target ? targetNodeId(hl.target, (n) => host.hasNode(n)) : null;
				at = id ? host.nodePos(id) : null;
			}
			if (at) {
				const pulse = reduced ? 0 : 0.5 + 0.5 * Math.sin(now / 260);
				ctx.beginPath();
				ctx.arc(at.x, at.y, r + pulse * 1.5 / k, 0, Math.PI * 2);
				ctx.fillStyle = rgba(color, 0.12);
				ctx.fill();
				ctx.lineWidth = 1.5 / k;
				ctx.strokeStyle = rgba(color, 0.8);
				ctx.stroke();
			}
		}
		ctx.restore();
	}

	private line(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, style: string): void {
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.strokeStyle = style;
		ctx.stroke();
	}

	// ── interaction ──

	/** The overlay thing under a screen point, or null. `slop` is the screen-px pick pad (bigger for touch). */
	hitTest(sx: number, sy: number, tr: { x: number; y: number; k: number }, slop: number): OverlayHit | null {
		if (!this.settings.enabled) return null;
		let best: OverlayHit | null = null;
		let bestD = Infinity;
		const prio: Record<OverlayKind, number> = { subagent: 0, thread: 1, you: 2, wolf: 3 };
		for (const it of this.cachedItems) {
			const px = it.x * tr.k + tr.x;
			const py = it.y * tr.k + tr.y;
			const d = Math.hypot(px - sx, py - sy) - it.r * tr.k;
			const reach = slop + (it.kind === "wolf" ? 2 : 0);
			if (d > reach) continue;
			const score = d + prio[it.kind] * 0.01;
			if (score < bestD) {
				bestD = score;
				best = { item: it, ring: it.needsYou && d > -2, sx: px, sy: py };
			}
		}
		return best;
	}

	/** The first thread of `wolf` (or any wolf) that waits for the owner, for the ring click. */
	needsYouThread(wolf: string, threadId?: string): { wolf: string; threadId: string } | null {
		const ts = Object.values(this.state.threads).filter((t) => t.needsYou && t.wolf === wolf);
		const t = ts.find((x) => x.id === threadId) ?? ts[0];
		return t ? { wolf: t.wolf, threadId: t.id } : null;
	}

	/** The card text for a hit (name, online, current thread, bound item; thread title and bound item; subagent name and parent). */
	cardFor(hit: OverlayHit): OverlayCard {
		const s = this.state;
		const p = this.privateView;
		const it = hit.item;
		if (it.kind === "wolf") {
			const w = s.wolves[it.wolf];
			const t = w?.activeThreadId ? s.threads[`${it.wolf}/${w.activeThreadId}`] : undefined;
			const lines = [w?.online ? "Online" : "Offline"];
			if (t) lines.push(`Thread: ${redact(t.title ?? threadSlugOf(t.wolf, t.id), p)}`);
			if (t?.bound) lines.push(`Working on: ${redact(t.bound.title ?? t.bound.id, p)}`);
			if (w?.needsYou) lines.push("Waiting for you");
			return { title: it.label, lines, action: t ? { kind: "open-thread", label: "Open thread", wolf: it.wolf, threadId: t.id } : undefined };
		}
		if (it.kind === "thread") {
			const t = s.threads[it.key];
			const lines = [t?.active ? "Active" : "Idle"];
			if (t?.bound) lines.push(`Working on: ${redact(t.bound.title ?? t.bound.id, p)}`);
			if (t?.needsYou) return { title: redact(it.label, p), lines: [...lines, "Waiting for you"], action: { kind: "answer", label: "Answer in chat", wolf: it.wolf, threadId: it.threadId } };
			return { title: redact(it.label, p), lines: [`Wolf: ${it.wolf}`, ...lines], action: { kind: "open-thread", label: "Open thread", wolf: it.wolf, threadId: it.threadId } };
		}
		if (it.kind === "subagent") {
			const parent = it.threadId ? s.threads[`${it.wolf}/${it.threadId}`] : undefined;
			return { title: redact(it.label, p), lines: [`Subagent of ${it.wolf}`, ...(parent ? [`Parent: ${redact(parent.title ?? threadSlugOf(parent.wolf, parent.id), p)}`] : [])], action: it.threadId ? { kind: "open-thread", label: "Open parent thread", wolf: it.wolf, threadId: it.threadId } : undefined };
		}
		const v = s.owner?.viewing;
		return { title: "You", lines: v ? [`Viewing: ${redact(v.title ?? v.id, p)}`] : this.attached ? ["In the floating chat"] : [] };
	}
}
