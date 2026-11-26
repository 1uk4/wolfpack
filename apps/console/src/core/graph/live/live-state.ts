/**
 * LIVE OVERLAY STATE (pure, no DOM): turns hub activity (`pack.activity` events, presence snapshots, clock ticks) into what the graph
 * overlay draws: wolves, thread and subagent satellites, pulses, fading trails, needs-you rings and the "you" node.
 *
 * Time: the browser's own clock (`now`, passed in every action) drives all expiry. An event expires `ttlMs` after it ARRIVED, a snapshot
 * entry after its remaining hub-side life (`expiresAt - snapshot.at`), so hub/browser clock skew never matters.
 * Privacy: only ids, kinds and short titles are kept, exactly what the event carries.
 */
import type { ActivityEvent, PresenceSnapshot } from "@wolfpack/protocol";

export interface LiveOptions {
	/** A finished subagent stays visible this long (default 15 s). */
	subagentFadeSec: number;
	/** A trail line fades out over this long (default 15 s). */
	trailSec: number;
	/** Trails kept at most; the oldest are dropped (default 200). */
	maxTrails: number;
	/** A pulse lives this long (ms). */
	pulseMs: number;
}
export const DEFAULT_LIVE_OPTIONS: LiveOptions = { subagentFadeSec: 15, trailSec: 15, maxTrails: 200, pulseMs: 2600 };

/** Console-wide home-domain guesses, used until a wolf shows its real domain through its events. */
export const HOME_DOMAIN_GUESS: Readonly<Record<string, string>> = { hal: "personal", jack: "snapjack", "1uk4": "wolfpack" };

export interface LiveTarget { kind: string; id: string; domain?: string; title?: string }

export interface LiveWolf {
	name: string;
	/** Any non-expired event. Offline wolves stay (dimmed at home). */
	online: boolean;
	expiresAt: number;
	lastTarget?: LiveTarget;
	/** The thread the wolf is currently active on. */
	activeThreadId?: string;
	needsYou: boolean;
	/** A wolf-level needs-you with no thread behind it; kept until `answered`, expiry or the wolf going offline. */
	needsYouThreadless?: boolean;
	/** Target-domain frequency, for the home-domain fallback. */
	domainCounts: Record<string, number>;
}
export interface LiveThread {
	id: string;
	wolf: string;
	title?: string;
	active: boolean;
	/** When the thread last went idle (it fades out from there, like a finished subagent). */
	idleAt?: number;
	bound?: LiveTarget;
	needsYou: boolean;
	expiresAt: number;
}
export interface LiveSubagent {
	key: string;
	name: string;
	wolf: string;
	parentThreadId?: string;
	title?: string;
	/** Set when `subagent-finished` arrived (fades from there). */
	finishedAt?: number;
	expiresAt: number;
}
export interface LiveTrail {
	id: string;
	wolf: string;
	threadId?: string;
	target: LiveTarget;
	verb: string;
	at: number;
}
export interface LivePulse { id: string; wolf: string; target: LiveTarget; verb: string; at: number }
export interface LiveOwner {
	viewing?: LiveTarget;
	expiresAt: number;
}

export interface LiveState {
	wolves: Record<string, LiveWolf>;
	threads: Record<string, LiveThread>;
	subagents: Record<string, LiveSubagent>;
	trails: LiveTrail[];
	pulses: LivePulse[];
	owner: LiveOwner | null;
	now: number;
}

export type LiveAction =
	| { type: "event"; event: ActivityEvent; now: number }
	| { type: "snapshot"; snapshot: PresenceSnapshot; now: number }
	| { type: "roster"; wolves: readonly string[]; now: number }
	| { type: "resync"; now: number }
	| { type: "tick"; now: number };

/** Trail/pulse origin name for hub-side writes (curator, system). Not a wolf: it never gets a body. */
export const HUB_WOLF = "@hub";

export const emptyLiveState = (now = 0): LiveState => ({ wolves: {}, threads: {}, subagents: {}, trails: [], pulses: [], owner: null, now });

const TRAIL_VERBS = new Set(["kb-read", "kb-write", "contribution", "shipped", "bound"]);
const KNOWN_VERBS = new Set(["thread-active", "thread-idle", "bound", "unbound", "subagent-spawned", "subagent-finished", "kb-read", "kb-write", "contribution", "shipped", "needs-you", "answered", "owner-viewing", "wolf-online", "wolf-offline"]);

const targetOf = (e: ActivityEvent): LiveTarget | undefined => (e.target ? { kind: e.target.kind, id: e.target.id, domain: e.target.domain ?? e.domain, title: e.target.title } : undefined);

function wolfEntry(s: LiveState, name: string): LiveWolf {
	return s.wolves[name] ?? { name, online: false, expiresAt: 0, needsYou: false, domainCounts: {} };
}

/** The wolf's home domain: its event domains' most frequent value, else the console's name guess, else undefined. */
export function homeDomainOf(w: LiveWolf | undefined, name: string): string | undefined {
	let best: string | undefined;
	let n = 0;
	for (const [d, c] of Object.entries(w?.domainCounts ?? {})) if (c > n) [best, n] = [d, c];
	return best ?? HOME_DOMAIN_GUESS[name];
}

/**
 * 0..1 opacity of a thread: 1 while active, bound, waiting on you or with a running subagent; an idle unbound thread fades linearly to 0
 * over the fade window, counted from the later of going idle and its last subagent finishing.
 */
export function threadAlpha(s: LiveState, t: LiveThread, now: number, fadeSec: number, subs?: readonly LiveSubagent[]): number {
	if (t.active || t.bound !== undefined || t.needsYou) return 1;
	let from = t.idleAt;
	// `subs` (this thread's subagents, when the caller has them indexed) saves a scan of every subagent per thread.
	for (const a of subs ?? Object.values(s.subagents)) {
		if (!subs && (a.wolf !== t.wolf || a.parentThreadId !== t.id)) continue;
		if (a.finishedAt === undefined) return 1;
		from = Math.max(from ?? -Infinity, a.finishedAt);
	}
	if (from === undefined) return 0;
	return fadeSec <= 0 ? 0 : Math.max(0, 1 - (now - from) / (fadeSec * 1000));
}

/** Threads worth drawing: active, bound, waiting on you, with a running subagent, or idle and still fading out. */
export function visibleThreads(s: LiveState, fadeSec = DEFAULT_LIVE_OPTIONS.subagentFadeSec, now = s.now): LiveThread[] {
	return Object.values(s.threads).filter((t) => threadAlpha(s, t, now, fadeSec) > 0);
}

/** 0..1 opacity of a subagent: 1 while running, linear fade to 0 over the fade window after it finished. */
export function subagentAlpha(a: LiveSubagent, now: number, fadeSec: number): number {
	if (a.finishedAt === undefined) return 1;
	return fadeSec <= 0 ? 0 : Math.max(0, 1 - (now - a.finishedAt) / (fadeSec * 1000));
}

/** 0..1 opacity of a trail over its life. */
export function trailAlpha(t: LiveTrail, now: number, trailSec: number): number {
	return trailSec <= 0 ? 0 : Math.max(0, 1 - (now - t.at) / (trailSec * 1000));
}

function withWolfNeeds(s: LiveState): LiveState {
	const need = new Set<string>();
	for (const t of Object.values(s.threads)) if (t.needsYou) need.add(t.wolf);
	let wolves = s.wolves;
	for (const w of Object.values(s.wolves)) {
		// Thread-level needs follow their threads; the wolf-level one lives in its own flag.
		const next = need.has(w.name) || w.needsYouThreadless === true;
		if (next !== w.needsYou) wolves = { ...wolves, [w.name]: { ...w, needsYou: next } };
	}
	return wolves === s.wolves ? s : { ...s, wolves };
}

function addTrail(s: LiveState, tr: LiveTrail, p: LivePulse, o: LiveOptions): LiveState {
	let trails = [...s.trails, tr];
	if (trails.length > o.maxTrails) trails = trails.slice(trails.length - o.maxTrails);
	return { ...s, trails, pulses: [...s.pulses, p].slice(-100) };
}

function applyEvent(s: LiveState, e: ActivityEvent, now: number, o: LiveOptions, snapshotLife?: number): LiveState {
	if (!KNOWN_VERBS.has(e.verb)) return s;
	const life = snapshotLife ?? e.ttlMs;
	const expiresAt = now + life;
	const fresh = snapshotLife === undefined; // live events draw pulses and trails; snapshot entries only restore state
	const wolfName = e.actor.wolf;
	let st: LiveState = { ...s, now };

	if (e.verb === "owner-viewing") {
		const t = targetOf(e);
		return { ...st, owner: { viewing: t, expiresAt } };
	}
	if (e.actor.kind === "hub") {
		// The hub's curator / system commits: a trail from the hub origin (no wolf body, no presence).
		const t = targetOf(e);
		if (!fresh || !t || e.verb !== "kb-write") return st;
		return addTrail(st, { id: e.id, wolf: HUB_WOLF, target: t, verb: e.verb, at: now }, { id: e.id, wolf: HUB_WOLF, target: t, verb: e.verb, at: now }, o);
	}
	if (!wolfName) return st;

	const target = targetOf(e);
	const w0 = wolfEntry(st, wolfName);
	const counts = { ...w0.domainCounts };
	const dom = target?.domain ?? e.domain;
	if (dom && fresh) counts[dom] = (counts[dom] ?? 0) + 1;
	let wolf: LiveWolf = { ...w0, online: true, expiresAt: Math.max(w0.expiresAt, expiresAt), domainCounts: counts };
	// A subagent's own thread id is not a thread on the map: it hangs off its parent thread.
	const isSub = e.actor.kind === "subagent";
	const threadId = isSub ? e.actor.parentThreadId : (e.actor.threadId ?? e.actor.parentThreadId);
	const tKey = threadId ? `${wolfName}/${threadId}` : undefined;
	const thread0 = tKey ? st.threads[tKey] : undefined;
	const mkThread = (): LiveThread => thread0 ?? { id: threadId!, wolf: wolfName, active: false, needsYou: false, expiresAt };
	const putThread = (t: LiveThread) => {
		st = { ...st, threads: { ...st.threads, [tKey!]: { ...t, expiresAt: Math.max(t.expiresAt, expiresAt), title: e.actor.title ?? t.title } } };
	};

	// Any non-finishing event from a subagent (an old hub overwrites its spawn with thread-active heartbeats) creates or refreshes it.
	if (isSub && e.actor.subagent && e.verb !== "subagent-finished") {
		const name = e.actor.subagent;
		const key = `${wolfName}/${threadId ?? ""}/${name}`;
		const prev = st.subagents[key];
		const keep = prev && prev.finishedAt === undefined ? prev : undefined;
		st = { ...st, subagents: { ...st.subagents, [key]: { key, name, wolf: wolfName, parentThreadId: threadId, title: e.actor.title ?? keep?.title, expiresAt: Math.max(keep?.expiresAt ?? 0, expiresAt) } } };
		if (e.verb === "thread-active" || e.verb === "thread-idle" || e.verb === "subagent-spawned") {
			st = { ...st, wolves: { ...st.wolves, [wolfName]: wolf } };
			return withWolfNeeds(st);
		}
	}

	switch (e.verb) {
		case "wolf-online":
			break; // the wolf is online (set above); nothing else to track
		case "wolf-offline":
			st = { ...st, wolves: { ...st.wolves, [wolfName]: { ...wolf, online: false, expiresAt: 0, activeThreadId: undefined, needsYou: false, needsYouThreadless: false } } };
			return withWolfNeeds(st);
		case "thread-active":
			if (tKey) {
				putThread({ ...mkThread(), active: true, idleAt: undefined });
				wolf = { ...wolf, activeThreadId: threadId };
			}
			break;
		case "thread-idle":
			if (tKey && thread0) {
				putThread({ ...thread0, active: false, idleAt: now });
				// An idle thread lives only for its fade (bound or waiting ones keep their event life).
				const cur = st.threads[tKey]!;
				const keep = cur.bound !== undefined || cur.needsYou;
				st = { ...st, threads: { ...st.threads, [tKey]: { ...cur, expiresAt: keep ? cur.expiresAt : now + o.subagentFadeSec * 1000 } } };
			}
			if (wolf.activeThreadId === threadId) wolf = { ...wolf, activeThreadId: undefined };
			break;
		case "bound":
			if (tKey && target) putThread({ ...mkThread(), bound: target });
			if (target) wolf = { ...wolf, lastTarget: target };
			break;
		case "unbound":
			if (tKey && thread0) putThread({ ...thread0, bound: undefined });
			break;
		case "subagent-spawned": {
			const name = e.actor.subagent;
			if (!name) break;
			const key = `${wolfName}/${threadId ?? ""}/${name}`;
			st = { ...st, subagents: { ...st.subagents, [key]: { key, name, wolf: wolfName, parentThreadId: threadId, title: e.actor.title, expiresAt } } };
			break;
		}
		case "subagent-finished": {
			const name = e.actor.subagent;
			if (!name) break;
			const key = `${wolfName}/${threadId ?? ""}/${name}`;
			const prev = st.subagents[key] ?? { key, name, wolf: wolfName, parentThreadId: threadId, title: e.actor.title, expiresAt };
			const fadeMs = o.subagentFadeSec * 1000;
			// A snapshot entry keeps its real remaining life: back-date finishedAt by the part of the fade already spent.
			const finishedAt = snapshotLife === undefined ? now : now - Math.max(0, fadeMs - snapshotLife);
			st = { ...st, subagents: { ...st.subagents, [key]: { ...prev, finishedAt, expiresAt: finishedAt + fadeMs } } };
			break;
		}
		case "needs-you":
			if (tKey) putThread({ ...mkThread(), needsYou: true });
			else wolf = { ...wolf, needsYouThreadless: true };
			wolf = { ...wolf, needsYou: true };
			break;
		case "answered":
			if (tKey && thread0) putThread({ ...thread0, needsYou: false });
			wolf = { ...wolf, needsYouThreadless: false }; // whether or not the thread is still in state
			break;
		default: // kb-read, kb-write, contribution, shipped
			if (target) wolf = { ...wolf, lastTarget: target };
	}
	st = { ...st, wolves: { ...st.wolves, [wolfName]: wolf } };
	if (fresh && target && TRAIL_VERBS.has(e.verb)) {
		const tr: LiveTrail = { id: e.id, wolf: wolfName, threadId, target, verb: e.verb, at: now };
		st = addTrail(st, tr, { id: e.id, wolf: wolfName, target, verb: e.verb, at: now }, o);
	}
	return withWolfNeeds(st);
}

function tick(s: LiveState, now: number, o: LiveOptions): LiveState {
	const wolves: Record<string, LiveWolf> = {};
	for (const [k, w] of Object.entries(s.wolves)) {
		const online = w.expiresAt > now;
		// An offline wolf stays, with no thread or alert state of its own.
		wolves[k] = online === w.online ? w : { ...w, online, activeThreadId: online ? w.activeThreadId : undefined, needsYou: online ? w.needsYou : false, needsYouThreadless: online ? w.needsYouThreadless : false };
	}
	const subagents = Object.fromEntries(Object.entries(s.subagents).filter(([, a]) => (a.finishedAt === undefined ? a.expiresAt > now : now < a.finishedAt + o.subagentFadeSec * 1000)));
	// A thread outlives its own expiry while one of its subagents is still in state (running or fading).
	const held = new Set(Object.values(subagents).map((a) => `${a.wolf}/${a.parentThreadId}`));
	const threads = Object.fromEntries(Object.entries(s.threads).filter(([k, t]) => t.expiresAt > now || held.has(k)));
	return withWolfNeeds({
		wolves,
		threads,
		subagents,
		trails: s.trails.filter((t) => now - t.at < o.trailSec * 1000),
		pulses: s.pulses.filter((p) => now - p.at < o.pulseMs),
		owner: s.owner && s.owner.expiresAt > now ? s.owner : null,
		now,
	});
}

/** What a viewer can see of a state; two states with the same signature draw the same. Shared by the store and the overlay. */
export function liveSignature(s: LiveState): string {
	const wolves = Object.values(s.wolves).map((w) => `${w.name}${w.online ? 1 : 0}${w.needsYou ? 1 : 0}`).join();
	return `${wolves}|${Object.keys(s.threads).length}|${Object.keys(s.subagents).length}|${s.trails.length}|${s.pulses.length}|${s.owner ? 1 : 0}`;
}

/** True while something in the state can still expire (so a clock is worth running). An offline roster alone is not. */
export function liveActive(s: LiveState): boolean {
	return Object.values(s.wolves).some((w) => w.online) || Object.keys(s.threads).length > 0 || Object.keys(s.subagents).length > 0 || s.trails.length > 0 || s.pulses.length > 0 || s.owner !== null;
}

/** The one reducer. Unknown verbs and malformed entries leave the state as it was. */
export function reduceLive(s: LiveState, a: LiveAction, o: LiveOptions = DEFAULT_LIVE_OPTIONS): LiveState {
	switch (a.type) {
		case "event":
			return applyEvent(s, a.event, a.now, o);
		case "tick":
			return tick(s, a.now, o);
		case "roster": {
			let wolves = s.wolves;
			for (const name of a.wolves) if (!wolves[name]) wolves = { ...wolves, [name]: wolfEntry(s, name) };
			return wolves === s.wolves ? s : { ...s, wolves };
		}
		case "resync": {
			// Frames may have been missed: forget everything event-derived (wolves stay, offline) until a snapshot rebuilds it.
			const wolves = Object.fromEntries(Object.entries(s.wolves).map(([k, w]) => [k, { ...w, online: false, expiresAt: 0, needsYou: false, needsYouThreadless: false, activeThreadId: undefined }]));
			return { ...emptyLiveState(a.now), wolves };
		}
		case "snapshot": {
			// Rebuild from the snapshot: threads, subagents, owner and wolf state come from it alone; known wolves stay on the roster.
			const base = reduceLive(s, { type: "resync", now: a.now }, o);
			let st = base;
			const snap = a.snapshot;
			for (const list of [snap.wolves, snap.threads, snap.subagents, snap.owner]) {
				for (const entry of list) {
					const life = entry.expiresAt - snap.at;
					if (life <= 0) continue;
					st = applyEvent(st, entry.event, a.now, o, life);
				}
			}
			return st;
		}
	}
}
