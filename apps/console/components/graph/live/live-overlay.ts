/**
 * The live overlay controller: owns the LiveState (src/core/graph/live), the wolf bodies (a PARALLEL lightweight sim that only reads graph
 * node positions, so KB nodes never move because of wolves), the satellite layout, drawing through the effect registry, and hit-testing.
 * The renderer (graph-canvas.ts) calls `step` and `draw` from its own rAF tick and asks `needsFrames()` whether to keep the loop alive.
 */
import {
	DEFAULT_LIVE_OPTIONS,
	emptyLiveState,
	featureOfThread,
	workShortId,
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
import { wolfSpringAnchor, ownerThreadKey, targetNodeId, threadKey, threadSlugOf } from "@/src/core";
import { separateSubs, stepSub, SUB_PHYSICS, tetherStrength, type SubBody } from "@/src/core";
import { WOLF_HEAD_BOX, WOLF_HEAD_PATH } from "@/components/shell/wolf-head-path";
import { AMBER, EFFECTS, rgba } from "./live-effects";
import { floatOffset, nameHash, roamOffset } from "./live-float";
import { redact } from "@/src/core";

export interface Pt { x: number; y: number }
export interface OverlayHost {
	nodePos(id: string): Pt | null;
	hasNode(id: string): boolean;
	nodeColor(id: string): string | undefined;
	center(): Pt;
	/** Bounding radius (world) of all nodes about `center()`; the wolves roam over a fraction of it. Absent or null: no roam. Cached by the host. */
	extentRadius?(): number | null;
	/** Base-layer radius (world) and label of a node: a hub on it is drawn a little larger and its card names the work item. */
	nodeRadius?(id: string): number | null;
	nodeLabel?(id: string): string | undefined;
	/** Tell the base layer which node dots the overlay replaces (hubs on their work nodes). Only called when the set changes. */
	setReplacedNodes?(ids: ReadonlySet<string>): void;
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

/** The main wolf is 1.4x the old icon: width in graph units before the clamps, and the screen-px clamps (it was 24 / 26 / 10). */
export const WOLF_WORLD_SIZE = 34;
export const WOLF_MAX_PX = 26 * 1.4;
export const WOLF_MIN_PX = 14;
/** Everything else (dots, hubs, subagents, offsets) is drawn in reference px for the old 26 px wolf and keeps that size: m divides the 1.4x out. */
const WOLF_SCALE = 1.4;
const REF_PX = 26;
/** Subagents are their own bodies: the wolf-head icon at 70% of the wolf's width (clearly bigger than a dot, a little smaller than the wolf). */
const SUBAGENT_RATIO = 0.7;
/** The same radius in reference px (the wolf icon is WOLF_SCALE * REF_PX wide at its cap), used by the physics through m. */
const SUB_R_REF = (WOLF_SCALE * REF_PX * SUBAGENT_RATIO) / 2;
/** A subagent's rest distance from its hub's centre (reference px): hub ring (~7.5) + its own radius (~12.7) + clear air. The link spring's rest length. */
const SUB_REST = 40;
/** A sub-agent's collision radius around its hub is the hub's drawn radius times this (the ring and its glow), and this share of a wolf's max size around a wolf. */
const HUB_CLEAR = 1.6;
const WOLF_CLEAR = 0.3;
/** The slot search per parent stops here (a parent with more live sub-agents than this reuses the last slot). */
const MAX_SUB_SLOTS = 64;
/** Successive subagents of one parent sit this far apart in angle (the golden angle: any count spreads evenly, never stacks). */
const SUB_SLOT_ANGLE = 2.399963;
/** Dot radius, orbits and offsets are in reference px (drawn for a 26 px wolf); they keep that proportion at every zoom. */
const THREAD_DOT_R = 3.2;
const SAT_ORBIT = 25;
const HOME_ORBIT = 36;
/** A subagent lingers this far from the node it went to, and idles this far outside its hub (or wolf). */
const SUB_TARGET_OFFSET = 14;
/** The feature hub's radius (reference px), its distance from its node, and from the domain node when it has no node of its own. */
const HUB_R = 7.5;
/** A hub on its work node is drawn at least this much bigger than the node's own dot. */
const HUB_NODE_GROW = 1.4;
const HUB_FALLBACK_OFFSET = 34;
const FLOAT_HUB_PX = 1.6;
/** The launch burst when a subagent leaves its hub (ms). */
const LAUNCH_MS = 900;
/** The you badge (screen px): radius, gap above the composer's top edge, and its margin off the canvas bottom when there is no composer. */
const YOU_BADGE_R = 13;
const YOU_GAP = 10;
const YOU_FALLBACK_MARGIN = 28;
const YOU_ACCENT = "#7aa2ff";
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
/** Roam: the wolf wanders freely over this fraction of the whole graph's extent (it belongs to no domain). */
const ROAM_FRAC = 0.3;
/** Each wolf's anchor sits on a ring of this fraction of the extent radius around the centre, evenly spread by name order from a fixed rotation. */
const ANCHOR_FRAC = 0.4;
const RING_ROTATION = -Math.PI / 2;
/** The anchor eases this far (0..1) toward the centroid of the wolf's recent activity, at this rate (1/s), over the last ACTIVITY_MS. */
const ACTIVITY_BIAS = 0.35;
const ANCHOR_EASE = 0.4;
const ACTIVITY_MS = 3 * 60_000;
/** Soft separation: wolves closer than this many wolf diameters are pushed apart at this rate (1/s); the offset relaxes home at SEP_RELAX (1/s). */
const SEP_DIAMETERS = 2.5;
const SEP_RATE = 2;
const SEP_RELAX = 0.15;
/** Roam clock speed: a working wolf roams at 1x, an idle one slower, an offline one nearly still (eased, so a change never jumps). */
const ROAM_SPEED_WORKING = 1;
const ROAM_SPEED_IDLE = 0.55;
const ROAM_SPEED_OFFLINE = 0.08;
/** A wolf body: the roam position plus the roam clock (ms) and its eased speed. */
interface Body {
	x: number;
	y: number;
	name: string;
	/** The eased anchor (ring slot biased toward recent activity), the roam offset, the separation offset, and the activity accumulators. */
	ax: number;
	ay: number;
	rx: number;
	ry: number;
	sx: number;
	sy: number;
	cx: number;
	cy: number;
	cn: number;
	/** Sum and count of its feature hubs (the invisible wolf-to-hub springs). */
	hx: number;
	hy: number;
	hn: number;
	placed: boolean;
	rt?: number;
	rs?: number;
}
/** A subagent body: spring-damper physics, when it was first seen (browser ms), the target event it last answered, and its tug target's offset angle. */
interface SubState extends SubBody { born: number; seen: number; lastPull: number; ang: number; pk: string; idx: number }
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
	return { wolfPx, m: wolfPx / (WOLF_SCALE * REF_PX) / k, compact: raw <= WOLF_MIN_PX };
}
let branchPath: Path2D | null = null;
/** lucide git-branch, in its 24 x 24 box. */
const branchGlyph = (): Path2D => (branchPath ??= new Path2D("M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"));
let userPath: Path2D | null = null;
/** lucide user, in its 24 x 24 box. */
const userGlyph = (): Path2D => (userPath ??= new Path2D("M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"));
/** The you badge (screen px) and its links, as the renderer and tests see them. `x,y` is where a link ends (the target, or the canvas edge when `arrow`). */
export interface YouLink { kind: "chat" | "view"; x: number; y: number; arrow: boolean; angle: number }
export interface YouGeometry { badge: { x: number; y: number; r: number }; links: YouLink[] }
let wolfHead: Path2D | null = null;
const wolfHeadPath = (): Path2D => (wolfHead ??= new Path2D(WOLF_HEAD_PATH));

export type OverlayKind = "wolf" | "thread" | "feature" | "subagent" | "you";
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
	/** Wolf: any thread or subagent running. Thread: active (within its heartbeat life). */
	working?: boolean;
	color: string;
	label: string;
	/** Feature: running subagents it has launched. */
	subCount?: number;
	/** Feature: the graph node this hub IS (its work node) and that node's label; absent for a fallback hub near the domain. */
	nodeId?: string;
	nodeLabel?: string;
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

/** What the overlay is animating right now: fast (pulses, wolf motion, tugs, you-node, highlight), float (the idle drift) or slow (fades). */
export type FrameNeed = "none" | "slow" | "float" | "fast";

/** Per wolf, recomputed only when its state object changes: home domain and the home angle from the name hash. */
interface WolfMeta { w: LiveWolf; dom: string | undefined; ang: number }

export class LiveOverlay {
	private state: LiveState = emptyLiveState(Date.now());
	private bodies = new Map<string, Body>();
	private roamTmp = { dx: 0, dy: 0 };
	/** Ring angle per wolf, recomputed only when the set of wolf names changes. */
	private ringAng = new Map<string, number>();
	private ringKey = "";
	private workingSet = new Set<string>();
	private springTmp = { x: 0, y: 0 };
	/** Subagent bodies by key (spring-damper physics) and the list the frame steps; the items they draw as, by key. */
	private subBodies = new Map<string, SubState>();
	private subList: SubState[] = [];
	/** The parent position and collision radius `anchorOf` found last (scratch, no allocation per frame). */
	private hubTmp: Pt = { x: 0, y: 0 };
	private hubR = 0;
	private subItems = new Map<string, OverlayItem>();
	/** Feature hubs by thread key and by short work id (the target of a wolf's own link). */
	private featureItems = new Map<string, OverlayItem>();
	private featureByWork = new Map<string, OverlayItem>();
	private anchorTmp: Pt = { x: 0, y: 0 };
	private need: FrameNeed = "none";
	private wolfMeta = new Map<string, WolfMeta>();
	private hashes = new Map<string, number>();
	private bodyList: Body[] = [];
	/** Per-frame indexes (rebuilt by items()): the wolf and thread items by key. */
	private wolfItems = new Map<string, OverlayItem>();
	private threadItems = new Map<string, OverlayItem>();
	private trailFrom = new Map<string, Pt>();
	private composer: { x: number; y: number; w: number; h: number } | null = null;
	private badge: { x: number; y: number; r: number } | null = null;
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
		if (this.highlight || s.pulses.length > 0) return "fast";
		const wall = Date.now();
		// Subagents darting to a target, launching from a hub or reeling back are fast motion; the wolves' slow roam is not.
		for (const b of this.subList) if (Math.abs(b.vx) + Math.abs(b.vy) > 0.4 || (b.tug && now - b.tug.at < 8000) || wall - b.born < LAUNCH_MS) return "fast";
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

	/** Spread the wolves evenly on the anchor ring in name order; a no-op while the set of wolves is unchanged. */
	private layoutRing(wolves: Record<string, LiveWolf>): void {
		const names = Object.keys(wolves).sort();
		const key = names.join("\0");
		if (key === this.ringKey) return;
		this.ringKey = key;
		this.ringAng.clear();
		names.forEach((n, i) => this.ringAng.set(n, RING_ROTATION + (Math.PI * 2 * i) / names.length));
	}

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

	/** Wolves with an active thread or a running subagent, into `workingSet` (reused, no allocation per frame). */
	private markWorking(): void {
		const ws = this.workingSet;
		ws.clear();
		const s = this.state;
		for (const id in s.threads) if (s.threads[id]!.active) ws.add(s.threads[id]!.wolf);
		for (const id in s.subagents) if (s.subagents[id]!.finishedAt === undefined) ws.add(s.subagents[id]!.wolf);
	}

	step(now: number, dtSec: number, host: OverlayHost, k: number): void {
		this.syncReplaced(host);
		if (!this.settings.enabled) return;
		const s = this.state;
		const { m } = scaleFor(k);
		const reduced = this.reduced;
		const bodies = this.bodyList;
		bodies.length = 0;
		this.markWorking();
		const center = host.center();
		const extent = host.extentRadius?.() ?? 0;
		const { wolfPx } = scaleFor(k);
		this.layoutRing(s.wolves);
		const ringR = extent > 0 ? extent * ANCHOR_FRAC : HOME_ORBIT * m;
		let fresh = false;
		// Pass A: a body per wolf (a new one is placed at its anchor at once, below) and the activity accumulators cleared.
		for (const name in s.wolves) {
			const w = s.wolves[name]!;
			let meta = this.wolfMeta.get(w.name);
			if (!meta || meta.w !== w) {
				meta = { w, dom: homeDomainOf(w, w.name), ang: (this.hashOf(w.name) % 360) * (Math.PI / 180) };
				this.wolfMeta.set(w.name, meta);
			}
			let b = this.bodies.get(w.name);
			if (!b) {
				b = { x: 0, y: 0, name: w.name, ax: 0, ay: 0, rx: 0, ry: 0, sx: 0, sy: 0, cx: 0, cy: 0, cn: 0, hx: 0, hy: 0, hn: 0, placed: false };
				this.bodies.set(w.name, b);
				fresh = true;
			}
			b.cx = 0;
			b.cy = 0;
			b.cn = 0;
			b.hx = 0;
			b.hy = 0;
			b.hn = 0;
			bodies.push(b);
		}
		// Pass B: the centroid of each wolf's recent activity: its feature hubs and the targets of its trails in the last few minutes.
		const wall = Date.now();
		for (const id in s.threads) {
			const t = s.threads[id]!;
			const b = t.feature !== undefined ? this.bodies.get(t.wolf) : undefined;
			if (!b) continue;
			const p = this.hubPos(t, host, m, this.anchorTmp);
			b.hx += p.x;
			b.hy += p.y;
			b.hn++;
		}
		for (const t of s.trails) {
			const b = wall - t.at < ACTIVITY_MS ? this.bodies.get(t.wolf) : undefined;
			if (!b) continue;
			const nid = targetNodeId(t.target, (n) => host.hasNode(n));
			const p = nid ? host.nodePos(nid) : null;
			if (!p) continue;
			b.cx += p.x;
			b.cy += p.y;
			b.cn++;
		}
		// Pass C: anchor (ring slot eased toward the activity), roam around it, and the separation offset relaxing home.
		const dt = Math.min(Math.max(dtSec, 0), 0.25);
		const ease = 1 - Math.exp(-dt * ANCHOR_EASE);
		for (const b of bodies) {
			const w = s.wolves[b.name]!;
			const h = this.hashOf(w.name);
			const ang = this.ringAng.get(w.name) ?? 0;
			// The ring slot, then the invisible springs to its feature hubs settle it near their rough centre (no hubs: the slot).
			const sp = wolfSpringAnchor(center.x + Math.cos(ang) * ringR, center.y + Math.sin(ang) * ringR, b.hx, b.hy, b.hn, this.springTmp);
			let tx = sp.x;
			let ty = sp.y;
			if (b.cn > 0) {
				tx += (b.cx / b.cn - tx) * ACTIVITY_BIAS;
				ty += (b.cy / b.cn - ty) * ACTIVITY_BIAS;
			}
			if (!b.placed || reduced) {
				b.ax = tx;
				b.ay = ty;
			} else {
				b.ax += (tx - b.ax) * ease;
				b.ay += (ty - b.ay) * ease;
			}
			const target = !w.online ? ROAM_SPEED_OFFLINE : this.workingSet.has(w.name) ? ROAM_SPEED_WORKING : ROAM_SPEED_IDLE;
			// The roam clock advances at an eased speed; the offset itself is a pure function of that clock (no drift to accumulate).
			const rs = (b.rs ?? target) + (target - (b.rs ?? target)) * (1 - Math.exp(-dtSec * 2));
			const rt = (b.rt ?? (h % 90_000)) + dt * 1000 * rs;
			const ro = roamOffset(h, rt, extent * ROAM_FRAC, reduced, this.roamTmp);
			b.rs = rs;
			b.rt = rt;
			b.rx = ro.dx;
			b.ry = ro.dy;
			if (!reduced && b.placed) {
				const f = Math.exp(-dt * SEP_RELAX);
				b.sx *= f;
				b.sy *= f;
			}
		}
		// Pass D: soft separation. A first appearance and reduced motion settle it at once (static); otherwise a light push per frame.
		const settle = fresh || reduced;
		const minD = SEP_DIAMETERS * (wolfPx / k);
		const rate = settle ? 1 : 1 - Math.exp(-dt * SEP_RATE);
		for (let pass = settle ? 12 : 1; pass > 0; pass--) {
			let moved = false;
			for (let i = 0; i < bodies.length; i++) {
				const a = bodies[i]!;
				for (let j = i + 1; j < bodies.length; j++) {
					const c = bodies[j]!;
					let dx = a.ax + a.rx + a.sx - (c.ax + c.rx + c.sx);
					let dy = a.ay + a.ry + a.sy - (c.ay + c.ry + c.sy);
					let d = Math.hypot(dx, dy);
					if (d >= minD) continue;
					if (d < 1e-6) {
						// Exactly stacked: split along a stable direction from the name.
						const an = (this.hashOf(a.name) % 360) * (Math.PI / 180);
						dx = Math.cos(an);
						dy = Math.sin(an);
						d = 0;
					} else {
						dx /= d;
						dy /= d;
					}
					const push = (minD - d) * 0.5 * rate;
					a.sx += dx * push;
					a.sy += dy * push;
					c.sx -= dx * push;
					c.sy -= dy * push;
					moved = true;
				}
			}
			if (!moved) break;
		}
		for (const b of bodies) {
			b.x = b.ax + b.rx + b.sx;
			b.y = b.ay + b.ry + b.sy;
			b.placed = true;
		}
		if (this.bodies.size > bodies.length) for (const name of [...this.bodies.keys()]) if (!s.wolves[name]) (this.bodies.delete(name), this.wolfMeta.delete(name));
		this.stepSubs(now, dtSec, host, k, m, reduced);
		// Trails remember where their actor WAS when the line began: the wolf, a feature hub or a subagent (stepSubs records those).
		for (const t of s.trails) {
			if (this.trailFrom.has(t.id) || t.subagentKey) continue;
			let from: Pt | null | undefined;
			if (t.featureKey) {
				const th = s.threads[t.featureKey];
				if (th) from = this.hubPos(th, host, m, this.anchorTmp);
			} else {
				// A hub-side write (curator) starts at the domain hub node, drawn in the neutral node colour.
				from = t.wolf === HUB_WOLF ? (t.target.domain ? host.nodePos(`dom:${t.target.domain}`) : null) : this.bodies.get(t.wolf);
			}
			if (from) this.trailFrom.set(t.id, { x: from.x, y: from.y });
		}
		if (this.trailFrom.size > s.trails.length + 50) {
			const live = new Set(s.trails.map((t) => t.id));
			for (const id of this.trailFrom.keys()) if (!live.has(id)) this.trailFrom.delete(id);
		}
	}

	/** Where a feature hub sits (world, no float): beside its work node, else beside its domain node, else near its wolf's home domain / the centre. */
	private hubPos(t: LiveThread, host: OverlayHost, m: number, out: Pt): Pt {
		const nodeId = this.hubNodeId(t, host);
		const dom = this.wolfMeta.get(t.wolf)?.dom;
		const domPos = dom ? host.nodePos("dom:" + dom) : null;
		const p = (nodeId ? host.nodePos(nodeId) : null) ?? domPos ?? host.center();
		if (nodeId) {
			// The hub IS its work node: exactly its position.
			out.x = p.x;
			out.y = p.y;
			return out;
		}
		const ang = (this.hashOf(t.id) % 360) * (Math.PI / 180);
		const d = HUB_FALLBACK_OFFSET * m;
		out.x = p.x + Math.cos(ang) * d;
		out.y = p.y + Math.sin(ang) * d;
		return out;
	}

	/** The work node a feature hub replaces (its `work:<short>` node), or null when that node is not on the graph. */
	private hubNodeId(t: LiveThread, host: OverlayHost): string | null {
		const wid = t.feature!;
		const dom = /^work-([a-z0-9]+)-/i.exec(wid)?.[1] ?? this.wolfMeta.get(t.wolf)?.dom;
		const id = targetNodeId({ kind: "work-item", id: wid, domain: dom }, (n) => host.hasNode(n));
		return id !== null && id.startsWith("work:") ? id : null;
	}

	private replaced = new Set<string>();
	private replacedTmp = new Set<string>();
	/** Tell the host which node dots the hubs replace; called only when that set differs from the last one told. */
	private syncReplaced(host: OverlayHost): void {
		if (!host.setReplacedNodes) return;
		const next = this.replacedTmp;
		next.clear();
		if (this.settings.enabled) {
			for (const id in this.state.threads) {
				const t = this.state.threads[id]!;
				if (t.feature === undefined) continue;
				const nid = this.hubNodeId(t, host);
				if (nid) next.add(nid);
			}
		}
		const cur = this.replaced;
		let same = next.size === cur.size;
		if (same) for (const id of next) if (!cur.has(id)) { same = false; break; }
		if (same) return;
		this.replaced = new Set(next);
		host.setReplacedNodes(this.replaced);
	}

	/** The parent key of a subagent: its feature thread, else its wolf. */
	private parentKeyOf(a: LiveSubagent): string {
		return a.parentThreadId ? threadKey(a.wolf, a.parentThreadId) : a.wolf;
	}

	/** A subagent's slot angle around its parent: a per-parent base plus its slot index times the golden angle. */
	private slotAngle(pk: string, idx: number): number {
		return (this.hashOf(pk) % 360) * (Math.PI / 180) + idx * SUB_SLOT_ANGLE;
	}

	/**
	 * Where a subagent's link spring rests: SUB_REST out from its feature hub (else its wolf) on its own slot angle. The parent's position
	 * goes to `hubTmp` and its collision radius to `hubR`.
	 */
	private anchorOf(a: LiveSubagent, host: OverlayHost, m: number, ang: number, out: Pt): Pt {
		const t = a.parentThreadId ? this.state.threads[threadKey(a.wolf, a.parentThreadId)] : undefined;
		if (t && t.feature !== undefined) {
			this.hubPos(t, host, m, out);
			this.hubR = HUB_R * m * HUB_CLEAR;
		} else {
			const wb = this.bodies.get(a.wolf) ?? host.center();
			out.x = wb.x;
			out.y = wb.y;
			this.hubR = WOLF_MAX_PX * m * WOLF_CLEAR;
		}
		this.hubTmp.x = out.x;
		this.hubTmp.y = out.y;
		out.x += Math.cos(ang) * SUB_REST * m;
		out.y += Math.sin(ang) * SUB_REST * m;
		return out;
	}

	/**
	 * Subagent bodies: born at their hub; a new target pulls them there hard (spring-damper), they linger, and with no target for ~10 s the
	 * tether reels them back; a finished one flies home to its hub (and fades there). Reduced motion: snap to the target (or the hub).
	 */
	private stepSubs(now: number, dtSec: number, host: OverlayHost, k: number, m: number, reduced: boolean): void {
		const s = this.state;
		const list = this.subList;
		list.length = 0;
		const wall = Date.now();
		const p = this.anchorTmp;
		for (const key in s.subagents) {
			const a = s.subagents[key]!;
			let b = this.subBodies.get(key);
			if (!b) {
				// The lowest slot of this parent that no live sibling holds: distinct angles from the first frame.
				const pk = this.parentKeyOf(a);
				let idx = 0;
				for (; idx < MAX_SUB_SLOTS; idx++) {
					let used = false;
					for (const o of this.subBodies.values()) if (o.pk === pk && o.idx === idx) used = true;
					if (!used) break;
				}
				this.anchorOf(a, host, m, this.slotAngle(pk, idx), p);
				// lastPull far in the past: with no target yet the link spring holds it at its rest length at full stiffness.
				b = { x: p.x, y: p.y, vx: 0, vy: 0, born: wall, seen: 0, lastPull: now - SUB_PHYSICS.idleMs - SUB_PHYSICS.rampMs, ang: (this.hashOf(key + "t") % 360) * (Math.PI / 180), pk, idx };
				this.subBodies.set(key, b);
			}
			list.push(b);
		}
		if (this.subBodies.size > list.length) for (const key of [...this.subBodies.keys()]) if (!s.subagents[key]) this.subBodies.delete(key);
		// A trail starts where its subagent WAS, before this frame's new target pulls it away.
		for (const t of s.trails) {
			if (!t.subagentKey || this.trailFrom.has(t.id)) continue;
			const b = this.subBodies.get(t.subagentKey);
			if (b) this.trailFrom.set(t.id, { x: b.x, y: b.y });
		}
		if (!reduced) separateSubs(list, dtSec); // mutual and hub repulsion, integrated by the steps below
		for (const key in s.subagents) {
			const a = s.subagents[key]!;
			const b = this.subBodies.get(key)!;
			const fin = a.finishedAt !== undefined;
			if (fin) b.tug = undefined;
			else if (a.target && a.targetAt !== undefined && a.targetAt > b.seen) {
				b.seen = a.targetAt;
				const id = targetNodeId(a.target, (n) => host.hasNode(n));
				const at = id ? host.nodePos(id) : null;
				if (at) {
					const tx = at.x + Math.cos(b.ang) * SUB_TARGET_OFFSET * m;
					const ty = at.y + Math.sin(b.ang) * SUB_TARGET_OFFSET * m;
					if (b.tug) [b.tug.x, b.tug.y, b.tug.at] = [tx, ty, now];
					else b.tug = { x: tx, y: ty, at: now };
					b.lastPull = now;
				}
			}
			if (b.tug && now - b.tug.at > SUB_PHYSICS.idleMs) b.tug = undefined; // nothing new for ~10 s: the tether takes over
			const anchor = this.anchorOf(a, host, m, this.slotAngle(b.pk, b.idx), p);
			b.r = SUB_R_REF * m;
			b.hx = this.hubTmp.x;
			b.hy = this.hubTmp.y;
			b.hr = this.hubR;
			if (reduced) {
				const to = b.tug ?? anchor;
				[b.x, b.y, b.vx, b.vy] = [to.x, to.y, 0, 0];
			} else {
				stepSub(b, now, dtSec, anchor.x, anchor.y, tetherStrength(SUB_PHYSICS, now - b.lastPull, fin), k);
			}
		}
	}

	/** World points the you badge links to: the viewed thread / item (secondary) and the floating chat's attached thread (primary). */
	private youLinks(host: OverlayHost): { chat: Pt | null; view: Pt | null } {
		const out: { chat: Pt | null; view: Pt | null } = { chat: null, view: null };
		const s = this.state;
		const v = s.owner?.viewing;
		if (v) {
			if (v.kind === "thread") {
				const key = ownerThreadKey(s);
				const t = key ? s.threads[key] : null;
				const it = t ? (this.threadItems.get(threadKey(t.wolf, t.id)) ?? this.wolfItems.get(t.wolf)) : null; // zoomed out the thread dot is hidden: link the wolf
				if (it) out.view = { x: it.x, y: it.y };
			} else {
				const id = targetNodeId(v, (n) => host.hasNode(n));
				const p = id ? host.nodePos(id) : null;
				if (p) out.view = p;
			}
		}
		// The chat's target: a feature thread's hub, otherwise the wolf's body (home and other threads).
		if (this.attached) {
			const a = this.attached;
			const slug = threadSlugOf(a.wolf, a.threadId);
			let it: OverlayItem | undefined;
			for (const i of this.featureItems.values()) {
				if (i.wolf === a.wolf && threadSlugOf(a.wolf, i.threadId ?? "") === slug) {
					it = i;
					break;
				}
			}
			const p = it ?? this.wolfItems.get(a.wolf);
			if (p) out.chat = { x: p.x, y: p.y };
		}
		return out;
	}

	/** The floating chat's rect in the graph's own screen coordinates (live-layer measures it once per change); null = no composer. */
	setComposerRect(r: { x: number; y: number; w: number; h: number } | null): void {
		const c = this.composer;
		if (c === r || (c && r && c.x === r.x && c.y === r.y && c.w === r.w && c.h === r.h)) return;
		this.composer = r ? { ...r } : null;
		this.requestFrame();
	}

	/**
	 * The you badge and its links in SCREEN px (independent of the camera): the badge sits just above the composer's top edge, centred on it,
	 * else bottom-centre of the canvas. A link ends at its target's screen position, or at the canvas edge with `arrow` when that is off screen.
	 * Reads the item indexes of the last frame's `items()`.
	 */
	screenGeometry(host: OverlayHost, tr: { x: number; y: number; k: number }, size: { w: number; h: number }): YouGeometry | null {
		if (!this.settings.enabled || Object.keys(this.state.wolves).length === 0) return null;
		const c = this.composer;
		const r = YOU_BADGE_R;
		const badge = c ? { x: c.x + c.w / 2, y: c.y - YOU_GAP - r, r } : { x: size.w / 2, y: size.h - YOU_FALLBACK_MARGIN - r, r };
		this.badge = badge;
		const world = this.youLinks(host);
		const links: YouLink[] = [];
		for (const [kind, p] of [["chat", world.chat], ["view", world.view]] as const) {
			if (!p) continue;
			const tx = p.x * tr.k + tr.x;
			const ty = p.y * tr.k + tr.y;
			const pad = 6;
			if (tx >= pad && tx <= size.w - pad && ty >= pad && ty <= size.h - pad) {
				links.push({ kind, x: tx, y: ty, arrow: false, angle: Math.atan2(ty - badge.y, tx - badge.x) });
				continue;
			}
			const dx = tx - badge.x;
			const dy = ty - badge.y;
			let t = 1;
			if (dx > 0) t = Math.min(t, (size.w - pad - badge.x) / dx);
			else if (dx < 0) t = Math.min(t, (pad - badge.x) / dx);
			if (dy > 0) t = Math.min(t, (size.h - pad - badge.y) / dy);
			else if (dy < 0) t = Math.min(t, (pad - badge.y) / dy);
			links.push({ kind, x: badge.x + dx * t, y: badge.y + dy * t, arrow: true, angle: Math.atan2(dy, dx) });
		}
		return { badge, links };
	}

	/** Screen-space pass (renderer calls it after `draw`, with the context at device scale): the you badge and its soft dashed links. */
	drawScreen(ctx: CanvasRenderingContext2D, host: OverlayHost, tr: { x: number; y: number; k: number }, size: { w: number; h: number }, now: number): void {
		const g = this.screenGeometry(host, tr, size);
		if (!g) return;
		const reduced = this.reduced;
		ctx.save();
		try {
			const { badge } = g;
			ctx.lineCap = "round";
			for (const l of g.links) {
				const sx = badge.x;
				const sy = badge.y - badge.r;
				const dx = l.x - sx;
				const dy = l.y - sy;
				const len = Math.hypot(dx, dy) || 1;
				// A soft bend: the control point sits off the midpoint, perpendicular to the line.
				const cx = sx + dx / 2 - (dy / len) * len * 0.15;
				const cy = sy + dy / 2 + (dx / len) * len * 0.15;
				const a = l.kind === "chat" ? 0.6 : 0.35;
				ctx.strokeStyle = rgba(YOU_ACCENT, a);
				ctx.lineWidth = 1.4;
				ctx.setLineDash([5, 5]);
				ctx.lineDashOffset = reduced ? 0 : -(now / 60) % 10; // a slow crawl toward the target; still under reduced motion
				ctx.beginPath();
				ctx.moveTo(sx, sy);
				ctx.quadraticCurveTo(cx, cy, l.x, l.y);
				ctx.stroke();
				ctx.setLineDash([]);
				if (l.arrow) {
					// Pointing along the way out: the angle of the end of the curve.
					const ang = Math.atan2(l.y - cy, l.x - cx);
					const h = 7;
					ctx.beginPath();
					ctx.moveTo(l.x, l.y);
					ctx.lineTo(l.x - Math.cos(ang - 0.45) * h, l.y - Math.sin(ang - 0.45) * h);
					ctx.moveTo(l.x, l.y);
					ctx.lineTo(l.x - Math.cos(ang + 0.45) * h, l.y - Math.sin(ang + 0.45) * h);
					ctx.strokeStyle = rgba(YOU_ACCENT, Math.min(0.9, a + 0.25));
					ctx.stroke();
				}
			}
			// The badge: a round plate with a soft glow and the lucide user glyph.
			ctx.shadowColor = rgba(YOU_ACCENT, 0.55);
			ctx.shadowBlur = 10;
			ctx.beginPath();
			ctx.arc(badge.x, badge.y, badge.r, 0, Math.PI * 2);
			ctx.fillStyle = rgba(YOU_ACCENT, 0.2);
			ctx.fill();
			ctx.shadowBlur = 0;
			ctx.lineWidth = 1.3;
			ctx.strokeStyle = rgba(YOU_ACCENT, 0.85);
			ctx.stroke();
			const gs = (badge.r * 1.1) / 24;
			ctx.translate(badge.x - 12 * gs, badge.y - 12 * gs);
			ctx.scale(gs, gs);
			ctx.lineWidth = 2;
			ctx.strokeStyle = rgba(YOU_ACCENT, 0.95);
			ctx.stroke(userGlyph());
		} finally {
			ctx.restore();
		}
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
			const key = threadKey(a.wolf, a.parentThreadId ?? "");
			const list = subsByThread.get(key);
			if (list) list.push(a);
			else subsByThread.set(key, [a]);
		}
		const threadsByWolf = new Map<string, { t: LiveThread; alpha: number }[]>();
		for (const id in s.threads) {
			const t = s.threads[id]!;
			const alpha = threadAlpha(s, t, now, fade, subsByThread.get(threadKey(t.wolf, t.id)) ?? []);
			if (alpha <= 0) continue;
			const list = threadsByWolf.get(t.wolf);
			if (list) list.push({ t, alpha });
			else threadsByWolf.set(t.wolf, [{ t, alpha }]);
		}
		this.wolfItems.clear();
		this.threadItems.clear();
		this.featureItems.clear();
		this.featureByWork.clear();
		this.subItems.clear();
		this.markWorking();
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
			const wolfItem: OverlayItem = { kind: "wolf", key: w.name, wolf: w.name, x: wx, y: wy, r: sc.wolfPx / 2 / k, alpha: w.online ? 1 : 0.35, needsYou: w.needsYou, online: w.online, working: w.online && this.workingSet.has(w.name), color, label: w.name };
			out.push(wolfItem);
			this.wolfItems.set(w.name, wolfItem);
			const all = threadsByWolf.get(w.name) ?? [];
			// Non-feature threads orbit the wolf as small dots (hidden when zoomed far out).
			const dots = sc.compact ? [] : all.filter((x) => !x.t.feature).sort((a, c) => (a.t.id < c.t.id ? -1 : 1));
			dots.forEach(({ t, alpha }, i) => {
				const ang = -Math.PI / 2 + (i - (dots.length - 1) / 2) * 0.75 + 0.35;
				const tx = wx + Math.cos(ang) * SAT_ORBIT * m;
				const ty = wy + Math.sin(ang) * SAT_ORBIT * m;
				const tkey = threadKey(t.wolf, t.id);
				const threadItem: OverlayItem = { kind: "thread", key: tkey, wolf: t.wolf, threadId: t.id, x: tx, y: ty, r: THREAD_DOT_R * m, alpha: (t.active ? 1 : 0.45) * alpha, needsYou: t.needsYou, online: w.online, working: t.active, color, label: t.title ?? threadSlugOf(t.wolf, t.id) };
				out.push(threadItem);
				this.threadItems.set(tkey, threadItem);
			});
			// A feature is a hub at its work node: a very slight float, working while its thread or any of its subagents is, dimmed when idle.
			for (const { t } of all) {
				if (!t.feature) continue;
				const tkey = threadKey(t.wolf, t.id);
				const pos = this.hubPos(t, host, m, this.anchorTmp);
				const nodeId = this.hubNodeId(t, host) ?? undefined;
				// On its node the hub does not float (it is the node); a fallback hub keeps its very slight drift.
				const hf = nodeId ? { dx: 0, dy: 0 } : floatOffset(this.hashOf(tkey), now, FLOAT_HUB_PX * m, { reduced });
				const nodeR = nodeId ? (host.nodeRadius?.(nodeId) ?? 0) : 0;
				let running = 0;
				for (const a of subsByThread.get(tkey) ?? []) if (a.finishedAt === undefined) running++;
				const working = t.active || running > 0;
				const hub: OverlayItem = { kind: "feature", key: tkey, wolf: t.wolf, threadId: t.id, x: pos.x + hf.dx, y: pos.y + hf.dy, r: Math.max(HUB_R * m, nodeR * HUB_NODE_GROW), alpha: working ? 1 : 0.5, needsYou: t.needsYou, online: w.online, working, color, label: t.title ?? threadSlugOf(t.wolf, t.id), subCount: running, nodeId, nodeLabel: nodeId ? host.nodeLabel?.(nodeId) : undefined };
				out.push(hub);
				this.threadItems.set(tkey, hub);
				this.featureItems.set(tkey, hub);
				this.featureByWork.set(workShortId(t.feature), hub);
			}
		}
		// Subagents roam the whole graph on their own physics bodies, with a small float on top.
		for (const id in s.subagents) {
			const a = s.subagents[id]!;
			const al = subagentAlpha(a, now, fade);
			const b = this.subBodies.get(a.key);
			if (!b || al <= 0.02) continue;
			const wi = this.wolfItems.get(a.wolf);
			const sf = floatOffset(this.hashOf(a.key), now, FLOAT_SUB_PX * m, { reduced });
			const item: OverlayItem = { kind: "subagent", key: a.key, wolf: a.wolf, threadId: a.parentThreadId, x: b.x + sf.dx, y: b.y + sf.dy, r: (sc.wolfPx * SUBAGENT_RATIO) / 2 / k, alpha: al, needsYou: false, online: wi?.online ?? true, color: wi?.color ?? host.colors.node, label: a.title ?? a.name };
			out.push(item);
			this.subItems.set(a.key, item);
		}
		this.cachedItems = out;
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
			const to = this.resolveTo(t.target, !t.subagentKey && !t.featureKey && t.wolf !== HUB_WOLF, host);
			const from = this.trailFrom.get(t.id);
			if (!to || !from) continue;
			const age = 1 - trailAlpha(t, wall, this.settings.trailSec);
			const w = this.wolfItems.get(t.wolf);
			EFFECTS.trail!({ ctx, x: from.x, y: from.y, toX: to.x, toY: to.y, r: 0, k, t: reduced ? Math.min(age, 0.6) : age, color: w?.color ?? host.colors.node, intensity: I, reduced });
		}
		// Pulses on the touched node.
		for (const p of s.pulses) {
			const at = this.resolveTo(p.target, !p.subagentKey && !p.featureKey && p.wolf !== HUB_WOLF, host);
			if (!at) continue;
			const w = this.wolfItems.get(p.wolf);
			EFFECTS.pulse!({ ctx, x: at.x, y: at.y, r: PULSE_R * m, k, t: Math.min(1, (wall - p.at) / DEFAULT_LIVE_OPTIONS.pulseMs), color: w?.color ?? host.colors.node, intensity: I, reduced });
		}
		// A subagent leaving its hub: a small burst there, for LAUNCH_MS.
		if (!reduced) {
			for (const id in s.subagents) {
				const a = s.subagents[id]!;
				const b = this.subBodies.get(a.key);
				if (!b || wall - b.born >= LAUNCH_MS || a.finishedAt !== undefined) continue;
				const hub = this.featureItems.get(threadKey(a.wolf, a.parentThreadId ?? "")) ?? this.wolfItems.get(a.wolf);
				if (hub) EFFECTS.pulse!({ ctx, x: hub.x, y: hub.y, r: HUB_R * m * 0.9, k, t: (wall - b.born) / LAUNCH_MS, color: hub.color, intensity: I, reduced });
			}
		}
		// Links: wolf -> its thread dots, thread -> bound work item (faint), and a hairline tether from each subagent to its hub (or wolf).
		ctx.lineWidth = 1.2 / k;
		const compactNow = scaleFor(k).compact;
		for (const it of items) {
			if (it.kind === "thread") {
				const wolf = this.wolfItems.get(it.wolf);
				if (wolf) this.line(ctx, wolf, it, rgba(it.color, 0.25 * it.alpha));
				const t = s.threads[it.key];
				if (t?.bound) {
					const p = this.resolveTo(t.bound, true, host);
					if (p) {
						ctx.setLineDash([2 / k, 3 / k]);
						this.line(ctx, it, p, rgba(it.color, 0.6 * it.alpha));
						ctx.setLineDash([]);
					}
				}
			} else if (it.kind === "subagent" && !compactNow) {
				const parent = this.featureItems.get(threadKey(it.wolf, it.threadId ?? "")) ?? this.wolfItems.get(it.wolf);
				if (parent) {
					ctx.lineWidth = 1 / k;
					this.line(ctx, parent, it, rgba(it.color, 0.35 * it.alpha));
					ctx.lineWidth = 1.2 / k;
				}
			}
		}
		// Zoomed out the thread dots are hidden: the link to the bound work item leaves the wolf itself.
		if (compactNow) {
			for (const id in s.threads) {
				const t = s.threads[id]!;
				const wolf = this.wolfItems.get(t.wolf);
				const p = t.bound && !t.feature ? this.resolveTo(t.bound, true, host) : null;
				if (!wolf || !p || threadAlpha(s, t, wall, this.settings.subagentFadeSec) <= 0) continue;
				ctx.setLineDash([2 / k, 3 / k]);
				this.line(ctx, wolf, p, rgba(wolf.color, 0.6));
				ctx.setLineDash([]);
			}
		}
		// Glyphs.
		for (const it of items) {
			ctx.globalAlpha = it.alpha;
			if (it.kind === "wolf") {
				if (it.online) {
					// Working: a stronger glow that slowly breathes (static and bright under reduced motion). Idle: a calm, faint one.
					const breath = it.working ? (reduced ? 1 : 0.8 + 0.2 * Math.sin(now / 900)) : 0.5;
					ctx.globalAlpha = it.alpha * breath;
					EFFECTS.glow!({ ctx, x: it.x, y: it.y, r: it.r * (it.working ? 1.25 : 1), k, t: 0, color: it.color, intensity: it.working ? Math.min(5, I + 1) : I, reduced });
					ctx.globalAlpha = it.alpha;
				}
				// The Wolfpack wolf-head centred on the body in the wolf's colour (alpha dims an offline wolf).
				ctx.save();
				ctx.translate(it.x - it.r, it.y - it.r);
				ctx.scale((it.r * 2) / WOLF_HEAD_BOX, (it.r * 2) / WOLF_HEAD_BOX);
				ctx.fillStyle = rgba(it.color, 0.95);
				ctx.fill(wolfHeadPath(), "evenodd");
				ctx.restore();
			} else if (it.kind === "feature") {
				// A hub: a ring plate in the wolf's colour with the git-branch glyph; working adds the pulsing ring, idle stays dim.
				ctx.beginPath();
				ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
				ctx.fillStyle = rgba(it.color, it.working ? 0.3 : 0.18);
				ctx.fill();
				ctx.lineWidth = 1.2 / k;
				ctx.strokeStyle = rgba(it.color, it.working ? 0.95 : 0.75);
				ctx.stroke();
				ctx.save();
				const gs = (it.r * 1.25) / 24;
				ctx.translate(it.x - it.r * 0.625, it.y - it.r * 0.625);
				ctx.scale(gs, gs);
				ctx.lineWidth = 2.4;
				ctx.lineCap = "round";
				ctx.strokeStyle = rgba(it.color, 0.95);
				ctx.stroke(branchGlyph());
				ctx.restore();
				if (it.working) this.drawWorkingRing(ctx, it, k, now, reduced);
			} else if (it.kind === "thread") {
				ctx.beginPath();
				ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
				ctx.fillStyle = rgba(it.color, it.working ? 1 : 0.7);
				ctx.fill();
				if (it.working) this.drawWorkingRing(ctx, it, k, now, reduced);
			} else if (it.kind === "subagent") {
				ctx.save();
				ctx.translate(it.x - it.r, it.y - it.r);
				ctx.scale((it.r * 2) / WOLF_HEAD_BOX, (it.r * 2) / WOLF_HEAD_BOX);
				ctx.fillStyle = rgba(it.color, 0.9);
				ctx.fill(wolfHeadPath(), "evenodd");
				ctx.restore();
			}
			ctx.globalAlpha = 1;
			if (it.needsYou && (it.kind === "wolf" || it.kind === "thread" || it.kind === "feature")) {
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

	/** Where a trail, pulse or bound link lands: the target's node; a wolf's own link to a feature lands on that feature's hub instead. */
	private resolveTo(target: LiveTarget, own: boolean, host: OverlayHost): Pt | null {
		if (own && target.kind === "work-item") {
			const f = this.featureByWork.get(workShortId(target.id));
			if (f) return f;
		}
		const id = targetNodeId(target, (n) => host.hasNode(n));
		return id ? host.nodePos(id) : null;
	}

	/** An active thread's soft pulsing ring and a short comet arc circling the dot; reduced motion: one static brighter ring. */
	private drawWorkingRing(ctx: CanvasRenderingContext2D, it: OverlayItem, k: number, now: number, reduced: boolean): void {
		ctx.lineWidth = 1.2 / k;
		if (reduced) {
			ctx.beginPath();
			ctx.arc(it.x, it.y, it.r * 1.9, 0, Math.PI * 2);
			ctx.strokeStyle = rgba(it.color, 0.5 * it.alpha);
			ctx.stroke();
			return;
		}
		const ph = ((now / 1600 + (this.hashOf(it.key) % 100) / 100) % 1 + 1) % 1;
		ctx.beginPath();
		ctx.arc(it.x, it.y, it.r * (1.5 + 1.0 * ph), 0, Math.PI * 2);
		ctx.strokeStyle = rgba(it.color, 0.5 * (1 - ph) * it.alpha);
		ctx.stroke();
		const a0 = now / 650 + (this.hashOf(it.key) % 628) / 100;
		ctx.beginPath();
		ctx.arc(it.x, it.y, it.r * 1.9, a0, a0 + 1.1);
		ctx.strokeStyle = rgba(it.color, 0.75 * it.alpha);
		ctx.lineCap = "round";
		ctx.stroke();
		ctx.lineCap = "butt";
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
		const bd = this.badge;
		if (bd && Math.hypot(sx - bd.x, sy - bd.y) - bd.r <= slop) {
			const item: OverlayItem = { kind: "you", key: "you", wolf: "", x: bd.x, y: bd.y, r: bd.r, alpha: 1, needsYou: false, online: true, color: YOU_ACCENT, label: "You" };
			return { item, ring: false, sx: bd.x, sy: bd.y };
		}
		let best: OverlayHit | null = null;
		let bestD = Infinity;
		const prio: Record<OverlayKind, number> = { subagent: 0, thread: 1, feature: 1, you: 2, wolf: 3 };
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
			const t = w?.activeThreadId ? s.threads[threadKey(it.wolf, w.activeThreadId)] : undefined;
			let features = 0;
			let subs = 0;
			for (const id in s.threads) if (s.threads[id]!.wolf === it.wolf && s.threads[id]!.feature !== undefined) features++;
			for (const id in s.subagents) if (s.subagents[id]!.wolf === it.wolf && s.subagents[id]!.finishedAt === undefined) subs++;
			const lines = [!w?.online ? "Offline" : it.working ? "Online · working" : "Online", `Open features: ${features}`, `Running subagents: ${subs}`];
			if (w?.needsYou) lines.push("Waiting for you");
			return { title: it.label, lines, action: t ? { kind: "open-thread", label: "Open thread", wolf: it.wolf, threadId: t.id } : undefined };
		}
		if (it.kind === "feature") {
			const t = s.threads[it.key];
			const lines = [`Wolf: ${it.wolf}`, it.working ? "Working" : "Idle", `Subagents: ${it.subCount ?? 0}`];
			if (it.nodeLabel) lines.unshift(`Work item: ${redact(it.nodeLabel, p)}`);
			if (t?.needsYou) lines.push("Waiting for you");
			return { title: redact(it.label, p), lines, action: { kind: t?.needsYou ? "answer" : "open-thread", label: t?.needsYou ? "Answer in chat" : "Open thread", wolf: it.wolf, threadId: it.threadId } };
		}
		if (it.kind === "thread") {
			const t = s.threads[it.key];
			const lines = [t?.active ? "Active" : "Idle"];
			if (t?.bound) lines.push(`Working on: ${redact(t.bound.title ?? t.bound.id, p)}`);
			if (t?.needsYou) return { title: redact(it.label, p), lines: [...lines, "Waiting for you"], action: { kind: "answer", label: "Answer in chat", wolf: it.wolf, threadId: it.threadId } };
			return { title: redact(it.label, p), lines: [`Wolf: ${it.wolf}`, ...lines], action: { kind: "open-thread", label: "Open thread", wolf: it.wolf, threadId: it.threadId } };
		}
		if (it.kind === "subagent") {
			const parent = it.threadId ? s.threads[threadKey(it.wolf, it.threadId)] : undefined;
			const target = s.subagents[it.key]?.target;
			const lines = [`Subagent of ${it.wolf}`];
			if (target) lines.push(`Target: ${redact(target.title ?? target.id, p)}`);
			if (parent) lines.push(`Parent: ${redact(parent.title ?? threadSlugOf(parent.wolf, parent.id), p)}`);
			return { title: redact(it.label, p), lines, action: it.threadId ? { kind: "open-thread", label: "Open parent thread", wolf: it.wolf, threadId: it.threadId } : undefined };
		}
		const v = s.owner?.viewing;
		const lines: string[] = [];
		const a = this.attached;
		if (a) {
			const slug = threadSlugOf(a.wolf, a.threadId);
			let title: string | undefined;
			for (const i of this.featureItems.values()) if (i.wolf === a.wolf && threadSlugOf(a.wolf, i.threadId ?? "") === slug) title = redact(i.label, p);
			lines.push(`Chatting with ${title ?? a.wolf}`);
		}
		if (v) lines.push(`Viewing: ${redact(v.title ?? v.id, p)}`);
		return { title: "You", lines };
	}
}
