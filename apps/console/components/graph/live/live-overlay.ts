/**
 * The live overlay controller: owns the LiveState (src/core/graph/live), the wolf bodies (a PARALLEL lightweight sim that only reads graph
 * node positions, so KB nodes never move because of wolves), the satellite layout, drawing through the effect registry, and hit-testing.
 * The renderer (graph-canvas.ts) calls `step` and `draw` from its own rAF tick and asks `needsFrames()` whether to keep the loop alive.
 */
import {
	DEFAULT_LIVE_OPTIONS,
	emptyLiveState,
	HUB_WOLF,
	homeDomainOf,
	liveActive,
	liveSignature,
	reduceLive,
	subagentAlpha,
	threadAlpha,
	trailAlpha,
	type LiveAction,
	type LiveSubagent,
	type LiveThread,
	type LiveWolf,
	type LiveOptions,
	type LiveState,
	type LiveTarget,
} from "@/src/core";
import { ownerThreadKey, targetNodeId, threadSlugOf } from "@/src/core";
import { DEFAULT_PHYSICS, stepWolves, wolvesMoving, type WolfBody } from "@/src/core";
import { WOLF_HEAD_BOX, WOLF_HEAD_PATH } from "@/components/shell/wolf-head-path";
import { AMBER, EFFECTS, rgba } from "./live-effects";
import { floatOffset, nameHash } from "./live-float";
import { redact } from "@/src/core";

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

/** The wolf icon's width in graph units before the clamps (nodeSize is 2 world units, a domain hub about 6x that, so the wolf reads as a hub plus its fan). */
export const WOLF_WORLD_SIZE = 24;
/** Screen-px clamps of the wolf icon: never bigger than the old constant 26, never smaller than 10 (still recognisable). */
export const WOLF_MAX_PX = 26;
export const WOLF_MIN_PX = 10;
/** Subagents wear the same logo, about 42% of the wolf's. */
const SUBAGENT_RATIO = 11 / 26;
/** Dot radius, orbits and offsets are in reference px (drawn for a 26 px wolf); they keep that proportion at every zoom. */
const THREAD_DOT_R = 3.2;
const SAT_ORBIT = 25;
const SUB_ORBIT = 12;
const SUB_FREE_ORBIT = 24;
const HOME_ORBIT = 36;
const TUG_OFFSET = 16;
const YOU_OFFSET = 22;
const YOU_R = 6;
const PULSE_R = 8;
const HL_R = 9;
const HL_PAD = 4;
/** Idle float amplitudes in reference px (through scaleFor(k).m): wolves about 3.5, subagent icons about 2. */
const FLOAT_WOLF_PX = 3.5;
const FLOAT_SUB_PX = 2;
/** Offline wolves drift smaller and slower. */
const FLOAT_OFFLINE_AMP = 0.4;
const FLOAT_OFFLINE_SLOW = 1.6;
/** Fully zoomed out the wolves are tiny: the float shrinks to a quiet shimmer. */
const FLOAT_COMPACT_AMP = 0.3;
/** Frame floors (ms) by kind of need. */
const FAST_MS = 16;
const FAST_MOBILE_MS = 30;
const SLOW_MS = 100;
const FLOAT_MS = 40;
const FLOAT_MOBILE_MS = 60;

export interface OverlayScale {
	/** Wolf icon width on screen, px. */
	wolfPx: number;
	/** World units per reference px (replaces the old `/ k`). */
	m: number;
	/** The wolf is at its MIN clamp: thread dots and subagent icons are hidden so they cannot scatter around a tiny cluster. */
	compact: boolean;
}
/** The one place the overlay's zoom scaling lives. */
export function scaleFor(k: number): OverlayScale {
	const raw = WOLF_WORLD_SIZE * k;
	const wolfPx = Math.min(WOLF_MAX_PX, Math.max(WOLF_MIN_PX, raw));
	return { wolfPx, m: wolfPx / WOLF_MAX_PX / k, compact: raw <= WOLF_MIN_PX };
}
let wolfHead: Path2D | null = null;
const wolfHeadPath = (): Path2D => (wolfHead ??= new Path2D(WOLF_HEAD_PATH));

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

const TUG_STALE_MS = 3000;
/** What the overlay is animating right now: fast (pulses, wolf motion, tugs, you-node, highlight), float (the idle drift) or slow (fades). */
export type FrameNeed = "none" | "slow" | "float" | "fast";

/** Per wolf, recomputed only when its state object changes: home domain and the home angle from the name hash. */
interface WolfMeta { w: LiveWolf; dom: string | undefined; ang: number }

export class LiveOverlay {
	private state: LiveState = emptyLiveState(Date.now());
	private bodies = new Map<string, WolfBody & { offline?: boolean }>();
	/** A target a wolf should drift to; dropped after TUG_STALE_MS if no frame consumed it (so it can never hold the frame loop). */
	private pendingTugs = new Map<string, { target: LiveTarget; at: number }>();
	private need: FrameNeed = "none";
	private wolfMeta = new Map<string, WolfMeta>();
	private hashes = new Map<string, number>();
	private bodyList: (WolfBody & { offline?: boolean })[] = [];
	/** Per-frame indexes (rebuilt by items()): the wolf and thread items by key. */
	private wolfItems = new Map<string, OverlayItem>();
	private threadItems = new Map<string, OverlayItem>();
	private trailFrom = new Map<string, Pt>();
	private you: Pt | null = null;
	private attached: AttachedRef | null = null;
	private highlight: OverlayHighlight | null = null;
	private settings: OverlaySettings = LIVE_DEFAULTS;
	private timer: ReturnType<typeof setInterval> | null = null;
	private mobileNow = false;
	/** Phone-sized or touch-first; recomputed on resize. */
	get mobile(): boolean {
		return this.mobileNow;
	}
	/** Read live, so a change of the OS setting applies without a reload. */
	get reduced(): boolean {
		return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	}

	constructor(private readonly requestFrame: () => void) {
		this.onResize();
	}

	/** The window or the graph changed size: re-read the phone check (a rotated or resized window changes the frame budget). */
	onResize(): void {
		const mq = (q: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches;
		this.mobileNow = mq("(pointer: coarse)") || (typeof window !== "undefined" && window.innerWidth < 700);
	}

	/** What the last `needsFrames` found (none / slow / float / fast). */
	get frameNeed(): FrameNeed {
		return this.need;
	}

	/** The least time between overlay frames for the current need: ~60 fps (30 on phones) for motion, 25 (16) for the idle float, 10 for fades. */
	get minFrameMs(): number {
		switch (this.need) {
			case "fast":
				return this.mobileNow ? FAST_MOBILE_MS : FAST_MS;
			case "float":
				return this.mobileNow ? FLOAT_MOBILE_MS : FLOAT_MS;
			case "slow":
				return SLOW_MS;
			default:
				return 0;
		}
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
			this.bodyList.length = 0;
			this.need = "none";
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
	}

	/** Anything left to animate (the renderer keeps its rAF loop alive only while this is true). */
	needsFrames(now: number): boolean {
		this.need = "none";
		if (!this.settings.enabled) return false;
		if (this.reduced) return false; // reduced motion: a still picture (rings, glows and positions are static)
		this.need = this.classifyNeed(now);
		return this.need !== "none";
	}

	/** fast > float > slow. No spreads or Object.values here: this runs on every rAF. The idle float holds the loop (at its own, lower, rate) while any wolf is shown; it also carries the needs-you ring's breathing. */
	private classifyNeed(now: number): FrameNeed {
		const s = this.state;
		if (this.highlight || s.pulses.length > 0 || this.youMoving) return "fast";
		const wall = Date.now();
		for (const p of this.pendingTugs.values()) if (wall - p.at < TUG_STALE_MS) return "fast";
		if (wolvesMoving(this.bodyList, now)) return "fast";
		for (const w in s.wolves) return "float"; // any wolf at all
		const fade = this.settings.subagentFadeSec;
		// Trails and fades keep frames coming only while they are still visibly fading.
		for (const t of s.trails) if (this.trailFrom.has(t.id) && trailAlpha(t, wall, this.settings.trailSec) > 0) return "slow";
		for (const id in s.subagents) {
			const a = s.subagents[id]!;
			if (a.finishedAt !== undefined && subagentAlpha(a, wall, fade) > 0.02) return "slow";
		}
		for (const id in s.threads) {
			const t = s.threads[id]!;
			if (t.active) continue;
			const al = threadAlpha(s, t, wall, fade);
			if (al > 0.02 && al < 1) return "slow"; // an idle thread is fading out
		}
		return "none";
	}
	private youMoving = false;

	private hashOf(name: string): number {
		let h = this.hashes.get(name);
		if (h === undefined) {
			h = nameHash(name);
			if (this.hashes.size > 2000) this.hashes.clear();
			this.hashes.set(name, h);
		}
		return h;
	}

	get hasAnything(): boolean {
		return this.settings.enabled && Object.keys(this.state.wolves).length > 0;
	}

	// ── physics + layout ──

	step(now: number, dtSec: number, host: OverlayHost, k: number): void {
		if (!this.settings.enabled) return;
		const s = this.state;
		const { m } = scaleFor(k);
		const bodies = this.bodyList;
		bodies.length = 0;
		for (const name in s.wolves) {
			const w = s.wolves[name]!;
			// Home domain and angle only change when the wolf's state object does.
			let meta = this.wolfMeta.get(w.name);
			if (!meta || meta.w !== w) {
				meta = { w, dom: homeDomainOf(w, w.name), ang: (this.hashOf(w.name) % 360) * (Math.PI / 180) };
				this.wolfMeta.set(w.name, meta);
			}
			const dom = meta.dom;
			const homePt = (dom ? host.nodePos(`dom:${dom}`) : null) ?? host.center();
			const ang = meta.ang;
			const home = { x: homePt.x + Math.cos(ang) * HOME_ORBIT * m, y: homePt.y + Math.sin(ang) * HOME_ORBIT * m };
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
				if (p) b.tug = { x: p.x + TUG_OFFSET * m, y: p.y - TUG_OFFSET * m, at: now };
			}
			this.pendingTugs.delete(w.name);
			bodies.push(b);
		}
		if (this.bodies.size > bodies.length) for (const name of [...this.bodies.keys()]) if (!s.wolves[name]) (this.bodies.delete(name), this.wolfMeta.delete(name));
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
			// A hub-side write (curator) starts at the domain hub node, drawn in the neutral node colour.
			const b = t.wolf === HUB_WOLF ? (t.target.domain ? host.nodePos(`dom:${t.target.domain}`) : null) : this.bodies.get(t.wolf);
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
		const off = YOU_OFFSET * scaleFor(k).m;
		return link ? { x: link.x - off, y: link.y - off } : null;
	}

	/** Points the you-node is linked to: the viewed thread / item first, then the floating chat's attached thread. */
	private youLinks(host: OverlayHost): Pt[] {
		const out: Pt[] = [];
		const s = this.state;
		const v = s.owner?.viewing;
		if (v) {
			if (v.kind === "thread") {
				const key = ownerThreadKey(s);
				const t = key ? s.threads[key] : null;
				const it = t ? this.threadItems.get(`${t.wolf}/${t.id}`) : null;
				if (it) out.push({ x: it.x, y: it.y });
			} else {
				const id = targetNodeId(v, (n) => host.hasNode(n));
				const p = id ? host.nodePos(id) : null;
				if (p) out.push(p);
			}
		}
		if (this.attached) {
			const a = this.attached;
			let it: OverlayItem | undefined;
			const slug = threadSlugOf(a.wolf, a.threadId);
			for (const i of this.threadItems.values()) {
				if (i.wolf === a.wolf && threadSlugOf(a.wolf, i.threadId ?? "") === slug) {
					it = i;
					break;
				}
			}
			const wb = this.wolfItems.get(a.wolf);
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
		const sc = scaleFor(k);
		const m = sc.m;
		const fade = this.settings.subagentFadeSec;
		const reduced = this.reduced;
		// Indexes built once per call: subagents by parent thread, visible threads by wolf.
		const subsByThread = new Map<string, LiveSubagent[]>();
		for (const id in s.subagents) {
			const a = s.subagents[id]!;
			const key = `${a.wolf}/${a.parentThreadId}`;
			const list = subsByThread.get(key);
			if (list) list.push(a);
			else subsByThread.set(key, [a]);
		}
		const threadsByWolf = new Map<string, { t: LiveThread; alpha: number }[]>();
		for (const id in s.threads) {
			const t = s.threads[id]!;
			const alpha = threadAlpha(s, t, now, fade, subsByThread.get(`${t.wolf}/${t.id}`) ?? []);
			if (alpha <= 0) continue;
			const list = threadsByWolf.get(t.wolf);
			if (list) list.push({ t, alpha });
			else threadsByWolf.set(t.wolf, [{ t, alpha }]);
		}
		this.wolfItems.clear();
		this.threadItems.clear();
		const placed = new Set<string>();
		for (const name in s.wolves) {
			const w = s.wolves[name]!;
			const b = this.bodies.get(w.name);
			if (!b) continue;
			const dom = this.wolfMeta.get(w.name)?.dom ?? homeDomainOf(w, w.name);
			const color = (dom && host.nodeColor(`dom:${dom}`)) || host.colors.node;
			// The idle float: a pure function of the clock, so every frame rate shows the same path.
			const fo = floatOffset(this.hashOf(w.name), now, FLOAT_WOLF_PX * m * (sc.compact ? FLOAT_COMPACT_AMP : 1) * (w.online ? 1 : FLOAT_OFFLINE_AMP), { reduced, slow: w.online ? 1 : FLOAT_OFFLINE_SLOW });
			const wx = b.x + fo.dx;
			const wy = b.y + fo.dy;
			const wolfItem: OverlayItem = { kind: "wolf", key: w.name, wolf: w.name, x: wx, y: wy, r: sc.wolfPx / 2 / k, alpha: w.online ? 1 : 0.35, needsYou: w.needsYou, online: w.online, color, label: w.name };
			out.push(wolfItem);
			this.wolfItems.set(w.name, wolfItem);
			const mine = sc.compact ? [] : (threadsByWolf.get(w.name) ?? []).sort((a, c) => (a.t.id < c.t.id ? -1 : 1));
			mine.forEach(({ t, alpha }, i) => {
				const ang = -Math.PI / 2 + (i - (mine.length - 1) / 2) * 0.75 + 0.35;
				const tx = wx + Math.cos(ang) * SAT_ORBIT * m;
				const ty = wy + Math.sin(ang) * SAT_ORBIT * m;
				const tkey = `${t.wolf}/${t.id}`;
				const threadItem: OverlayItem = { kind: "thread", key: tkey, wolf: t.wolf, threadId: t.id, x: tx, y: ty, r: THREAD_DOT_R * m, alpha: (t.active ? 0.95 : 0.55) * alpha, needsYou: t.needsYou, online: w.online, color, label: t.title ?? threadSlugOf(t.wolf, t.id) };
				out.push(threadItem);
				this.threadItems.set(tkey, threadItem);
				const subs = subsByThread.get(tkey) ?? [];
				subs.forEach((a, j) => {
					const al = subagentAlpha(a, now, fade);
					if (al <= 0.02) return;
					const h = this.hashOf(a.key);
					// Subagents drift a little and wobble slowly around their thread.
					const sf = floatOffset(h, now, FLOAT_SUB_PX * m, { reduced });
					const wob = reduced ? 0 : 0.25 * Math.sin(now / 1400 + (h % 628) / 100);
					const sa = ang + (j - (subs.length - 1) / 2) * 0.9 + wob;
					out.push({ kind: "subagent", key: a.key, wolf: a.wolf, threadId: t.id, x: tx + Math.cos(sa) * SUB_ORBIT * m + sf.dx, y: ty + Math.sin(sa) * SUB_ORBIT * m + sf.dy, r: (sc.wolfPx * SUBAGENT_RATIO) / 2 / k, alpha: al, needsYou: false, online: w.online, color, label: a.title ?? a.name });
					placed.add(a.key);
				});
			});
		}
		// Subagents whose parent thread is hidden or unknown hang off their wolf.
		for (const id in s.subagents) {
			const a = s.subagents[id]!;
			if (placed.has(a.key)) continue;
			const wi = this.wolfItems.get(a.wolf);
			const al = subagentAlpha(a, now, fade);
			if (!wi || al <= 0.02 || sc.compact) continue;
			const h = this.hashOf(a.key);
			const sf = floatOffset(h, now, FLOAT_SUB_PX * m, { reduced });
			const ang = (h % 360) * (Math.PI / 180) + (reduced ? 0 : 0.25 * Math.sin(now / 1400 + (h % 628) / 100));
			out.push({ kind: "subagent", key: a.key, wolf: a.wolf, threadId: a.parentThreadId, x: wi.x + Math.cos(ang) * SUB_FREE_ORBIT * m + sf.dx, y: wi.y + Math.sin(ang) * SUB_FREE_ORBIT * m + sf.dy, r: (sc.wolfPx * SUBAGENT_RATIO) / 2 / k, alpha: al, needsYou: false, online: true, color: wi.color, label: a.title ?? a.name });
		}
		this.cachedItems = out;
		if (this.you) out.push({ kind: "you", key: "you", wolf: "", x: this.you.x, y: this.you.y, r: YOU_R * m, alpha: 1, needsYou: false, online: true, color: host.colors.hoverText, label: "You" });
		return out;
	}

	// ── drawing (world coordinates, camera already applied) ──

	/**
	 * `now` is the renderer's monotonic clock (animation phase only). Everything stored in the state (idle and finish times, trails, pulses)
	 * is epoch ms, so fades are computed from the wall clock here, never from `now`.
	 */
	draw(ctx: CanvasRenderingContext2D, host: OverlayHost, k: number, now: number): void {
		if (!this.settings.enabled || Object.keys(this.state.wolves).length === 0) return;
		ctx.save();
		try {
			this.drawBody(ctx, host, k, now, Date.now());
		} finally {
			ctx.restore(); // a throw mid-draw must not leave the canvas context unbalanced
		}
	}

	private drawBody(ctx: CanvasRenderingContext2D, host: OverlayHost, k: number, now: number, wall: number): void {
		const s = this.state;
		const I = this.settings.intensity;
		const reduced = this.reduced;
		const m = scaleFor(k).m;
		const items = this.items(host, k, wall);
		ctx.lineCap = "round";

		// Trails: the path the wolf took to the thing it touched, fading over trailSec.
		for (const t of s.trails) {
			const id = targetNodeId(t.target, (n) => host.hasNode(n));
			const to = id ? host.nodePos(id) : null;
			const from = this.trailFrom.get(t.id);
			if (!to || !from) continue;
			const age = 1 - trailAlpha(t, wall, this.settings.trailSec);
			const w = this.wolfItems.get(t.wolf);
			EFFECTS.trail!({ ctx, x: from.x, y: from.y, toX: to.x, toY: to.y, r: 0, k, t: reduced ? Math.min(age, 0.6) : age, color: w?.color ?? host.colors.node, intensity: I, reduced });
		}
		// Pulses on the touched node.
		for (const p of s.pulses) {
			const id = targetNodeId(p.target, (n) => host.hasNode(n));
			const at = id ? host.nodePos(id) : null;
			if (!at) continue;
			const w = this.wolfItems.get(p.wolf);
			EFFECTS.pulse!({ ctx, x: at.x, y: at.y, r: PULSE_R * m, k, t: Math.min(1, (wall - p.at) / DEFAULT_LIVE_OPTIONS.pulseMs), color: w?.color ?? host.colors.node, intensity: I, reduced });
		}
		// Links: wolf -> its thread dots, thread -> bound work item (faint), subagent -> parent.
		ctx.lineWidth = 0.8 / k;
		for (const it of items) {
			if (it.kind === "thread") {
				const wolf = this.wolfItems.get(it.wolf);
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
				const parent = this.threadItems.get(`${it.wolf}/${it.threadId}`) ?? this.wolfItems.get(it.wolf);
				if (parent) this.line(ctx, parent, it, rgba(it.color, 0.2 * it.alpha));
			}
		}
		// The you-node's dashed links.
		const last = items[items.length - 1];
		const you = last?.kind === "you" ? last : undefined;
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
				// The Wolfpack wolf-head centred on the body in the wolf's colour (alpha dims an offline wolf).
				ctx.save();
				ctx.translate(it.x - it.r, it.y - it.r);
				ctx.scale((it.r * 2) / WOLF_HEAD_BOX, (it.r * 2) / WOLF_HEAD_BOX);
				ctx.fillStyle = rgba(it.color, 0.95);
				ctx.fill(wolfHeadPath(), "evenodd");
				ctx.restore();
			} else if (it.kind === "thread") {
				ctx.beginPath();
				ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
				ctx.fillStyle = rgba(it.color, 0.9);
				ctx.fill();
			} else if (it.kind === "subagent") {
				ctx.save();
				ctx.translate(it.x - it.r, it.y - it.r);
				ctx.scale((it.r * 2) / WOLF_HEAD_BOX, (it.r * 2) / WOLF_HEAD_BOX);
				ctx.fillStyle = rgba(it.color, 0.9);
				ctx.fill(wolfHeadPath(), "evenodd");
				ctx.restore();
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
			let r = HL_R * m;
			let color = host.colors.hoverText;
			if (hl.wolf) {
				const it = this.wolfItems.get(hl.wolf);
				if (it) [at, r, color] = [it, it.r + HL_PAD * m, it.color];
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
