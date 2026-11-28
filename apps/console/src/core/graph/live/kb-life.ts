/**
 * KB LIFE (pure, no DOM): the memory pipeline as motion on the live map. Events (memory-observe / -consolidate / -promote from a wolf,
 * curate-start / -done from the hub's curator) become: each wolf's buffer fill, gathered topic dots, FLIGHTS of those topics to the curator
 * (queued and paced, never dropped), the curator's shimmer, and results (a new node for a create, a pulse on the entry for a merge,
 * a fade at the curator for reject / parked).
 *
 * Time is the browser's clock (`now`, ms) passed into every call; flights are phases with timestamps, so the drawing is a function of
 * (state, now). Correlation: a curate-* event joins a promote by detail.topicIds[0] (the den topic id, also curate-done's detail.ref).
 * Reduced motion: flights take no time (the topic is at the curator at once, the result lands at once); only the fades and pulses stay.
 */
import type { ActivityEvent } from "@wolfpack/protocol";

export const KB_VERBS: ReadonlySet<string> = new Set(["memory-observe", "memory-consolidate", "memory-promote", "curate-start", "curate-done"]);
export const isKbVerb = (verb: string): boolean => KB_VERBS.has(verb);

/** A topic takes this long to travel to the curator, and its result to float to its section (slow on purpose). */
export const KB_TRAVEL_MS = 5000;
export const KB_PLACE_MS = 3000;
export const KB_FADE_MS = 1600;
/** Flights start at least this far apart, and at most this many are in the air / at the curator at once; the rest queue. */
export const KB_STAGGER_MS = 900;
export const KB_MAX_FLIGHTS = 6;
export const KB_MAX_QUEUE = 80;
export const KB_PULSE_MS = 2600;
/** A landed entry's nerve pulse: the run down the tree, the lit path that stays after it reaches the entry, then the final ring (KB_PULSE_MS). */
export const KB_NERVE_MS = 1800;
export const KB_NERVE_GLOW_MS = 10_000;
/** A consolidated topic nobody promotes stays beside its wolf this long; a flight whose curator never answers fades after this. */
export const KB_TOPIC_TTL_MS = 120_000;
export const KB_WAIT_MAX_MS = 60_000;
/** curate-start is a hub event (30 s ttl): the curator shimmers at most this long without a done. */
export const KB_CURATOR_TTL_MS = 30_000;
export const KB_FILL_EASE_MS = 600;
export const KB_MAX_TOPICS_PER_WOLF = 8;
/** Domains kept (where the curator mark sits); past this the oldest is forgotten. */
export const KB_MAX_DOMAINS = 50;
const withDomain = (list: string[], d: string | undefined): string[] => (d && !list.includes(d) ? [...list, d].slice(-KB_MAX_DOMAINS) : list);

export interface KbWolf { count: number; capacity: number; fill: number; prevFill: number; changedAt: number }
/** Topic dots on the Home ring (the draw cap); a flight keeps its topic's ring place only while the topic was among the first of these. */
export const KB_RING_MAX = 6;
/** `slot` is the topic's fixed place on the ring round Home; the flight made from it inherits it. */
export interface KbTopic { id: string; wolf: string; born: number; slot: number }
export type KbOutcome = "create" | "merge" | "reject" | "parked";
export interface KbResult { outcome: string; title?: string; entryId?: string; domain?: string; section?: string; sectionPath?: string[]; sectionTitle?: string; ms?: number; tokens?: number }
export type FlightStage = "queued" | "travel" | "wait" | "place" | "fade";
export interface KbFlight {
	/** The den topic id (the correlation key). */
	id: string;
	wolf: string;
	domain?: string;
	/** Contribution id (promote detail.ref). */
	ref?: string;
	stage: FlightStage;
	queuedAt: number;
	/** Phase start (travel start, wait start, place/fade start) and the end of the current timed phase. */
	at: number;
	endAt: number;
	/** Slot around the curator, so concurrent flights do not stack. */
	slot: number;
	result?: KbResult;
	/** Set when the flight comes from a topic dot that reached the ring: when that dot was born, so the flight carries on from its ring place instead of the wolf. */
	born?: number;
	/** A flight made from a curate-done alone (no promote seen): it starts at the curator. */
	synthetic?: true;
}
export interface KbPulse { id: string; kind: "create" | "merge" | "retire"; outcome?: string; title?: string; sectionTitle?: string; entryId?: string; domain?: string; section?: string; sectionPath?: string[]; at: number }
export interface KbLife {
	wolves: Record<string, KbWolf>;
	topics: KbTopic[];
	flights: KbFlight[];
	pulses: KbPulse[];
	/** Topic ids the curator is working on now (curate-start without a done yet), and when each began. */
	curator: Record<string, number>;
	/** Domains seen (where the curator mark sits). */
	domains: string[];
	lastStartAt: number;
	slotSeq: number;
	reduced: boolean;
	now: number;
}

export const emptyKbLife = (now = 0, reduced = false): KbLife => ({ wolves: {}, topics: [], flights: [], pulses: [], curator: {}, domains: [], lastStartAt: -Infinity, slotSeq: 0, reduced, now });

const topicOf = (e: ActivityEvent): string | undefined => e.detail?.topicIds?.[0] ?? e.detail?.ref;

/** Fold one pack.activity event in. Other verbs leave the state as it was. */
export function reduceKbLife(s: KbLife, e: ActivityEvent, now: number): KbLife {
	if (!isKbVerb(e.verb)) return s;
	const d = e.detail ?? {};
	switch (e.verb) {
		case "memory-observe": {
			const wolf = e.actor.wolf;
			if (!wolf || !d.capacity || d.capacity <= 0) return s;
			const prev = s.wolves[wolf];
			const fill = Math.max(0, Math.min(1, (d.count ?? 0) / d.capacity));
			return { ...s, now, wolves: { ...s.wolves, [wolf]: { count: d.count ?? 0, capacity: d.capacity, fill, prevFill: prev ? displayFill(prev, now) : 0, changedAt: now } } };
		}
		case "memory-consolidate": {
			const wolf = e.actor.wolf;
			if (!wolf) return s;
			const prev = s.wolves[wolf];
			const wolves = prev ? { ...s.wolves, [wolf]: { ...prev, count: 0, fill: 0, prevFill: displayFill(prev, now), changedAt: now } } : s.wolves;
			const have = new Set(s.topics.map((t) => t.id));
			const fresh = (d.topicIds ?? []).filter((id) => !have.has(id)).map((id, i): KbTopic => ({ id, wolf, born: now, slot: s.slotSeq + i }));
			let topics = [...s.topics, ...fresh];
			const slotSeq = s.slotSeq + fresh.length;
			const mine = topics.filter((t) => t.wolf === wolf);
			if (mine.length > KB_MAX_TOPICS_PER_WOLF) {
				const drop = new Set(mine.slice(0, mine.length - KB_MAX_TOPICS_PER_WOLF).map((t) => t.id));
				topics = topics.filter((t) => !drop.has(t.id));
			}
			return { ...s, now, wolves, topics, slotSeq };
		}
		case "memory-promote": {
			const wolf = e.actor.wolf;
			const id = topicOf(e);
			if (!wolf || !id) return s;
			const domain = e.target?.id ?? e.domain;
			const topics = s.topics.filter((t) => t.id !== id);
			const own = s.topics.findIndex((t) => t.id === id);
			const ownT = own >= 0 && own < KB_RING_MAX ? s.topics[own] : undefined;
			const domains = withDomain(s.domains, domain);
			if (s.flights.some((f) => f.id === id)) return { ...s, now, topics, domains }; // a repeat of the same promote
			let flights = [...s.flights, { id, wolf, ...(domain ? { domain } : {}), ...(d.ref ? { ref: d.ref } : {}), stage: "queued" as const, queuedAt: now, at: now, endAt: now, slot: ownT ? ownT.slot : s.slotSeq, ...(ownT ? { born: ownT.born } : {}) }];
			const queued = flights.filter((f) => f.stage === "queued");
			if (queued.length > KB_MAX_QUEUE) {
				const drop = queued[0]!;
				flights = flights.filter((f) => f !== drop); // the one thing that is dropped: an absurd backlog, oldest first
			}
			return { ...s, now, topics, domains, flights, slotSeq: ownT ? s.slotSeq : s.slotSeq + 1 };
		}
		case "curate-start": {
			const id = topicOf(e);
			if (!id) return s;
			return { ...s, now, curator: { ...s.curator, [id]: now } };
		}
		case "curate-done": {
			const id = topicOf(e);
			const curator = { ...s.curator };
			if (id) delete curator[id];
			const result: KbResult = {
				outcome: d.outcome ?? "merge",
				...(e.target?.title ? { title: e.target.title } : {}),
				...(e.target?.kind === "kb-entry" ? { entryId: e.target.id } : {}),
				...(e.target?.domain ?? e.domain ? { domain: (e.target?.domain ?? e.domain)! } : {}),
				...(d.section ? { section: d.section } : {}),
				...(d.sectionPath?.length ? { sectionPath: d.sectionPath } : {}),
				...(d.sectionTitle ? { sectionTitle: d.sectionTitle } : {}),
				...(d.ms !== undefined ? { ms: d.ms } : {}),
				...(d.tokens !== undefined ? { tokens: d.tokens } : {}),
			};
			const domain = result.domain;
			const domains = withDomain(s.domains, domain);
			const hit = id ? s.flights.find((f) => f.id === id && !f.result) : undefined;
			if (hit) {
				return { ...s, now, curator, domains, flights: s.flights.map((f) => (f === hit ? { ...f, result, ...(domain && !f.domain ? { domain } : {}) } : f)) };
			}
			const flight: KbFlight = { id: id ?? e.id, wolf: "", ...(domain ? { domain } : {}), stage: "wait", queuedAt: now, at: now, endAt: now, slot: s.slotSeq, result, synthetic: true };
			return { ...s, now, curator, domains, flights: [...s.flights, flight], slotSeq: s.slotSeq + 1 };
		}
	}
	return s;
}

/** The ring's fill 0..1, eased from the previous value over KB_FILL_EASE_MS. */
export function displayFill(w: KbWolf, now: number): number {
	const t = Math.max(0, Math.min(1, (now - w.changedAt) / KB_FILL_EASE_MS));
	return w.prevFill + (w.fill - w.prevFill) * t;
}

export type KbNervePhase = "run" | "lit" | "ring" | "done";
/**
 * Where a landed pulse is in its life at `now`: run (t = 0..1 along the path), lit (t = elapsed share of the glow), ring (t = 0..1), done.
 * Reduced motion has no run: the lit path (faded in and out by the drawing) starts at landing.
 */
export function kbNerveState(p: Pick<KbPulse, "at">, now: number, reduced: boolean): { phase: KbNervePhase; t: number } {
	let e = now - p.at;
	if (!reduced) {
		if (e < KB_NERVE_MS) return { phase: "run", t: Math.max(0, e) / KB_NERVE_MS };
		e -= KB_NERVE_MS;
	}
	if (e < KB_NERVE_GLOW_MS) return { phase: "lit", t: Math.max(0, e) / KB_NERVE_GLOW_MS };
	e -= KB_NERVE_GLOW_MS;
	return e < KB_PULSE_MS ? { phase: "ring", t: e / KB_PULSE_MS } : { phase: "done", t: 1 };
}

const dur = (s: KbLife, ms: number) => (s.reduced ? 0 : ms);

/** Advance the phases to `now`: start queued flights (paced and capped), move arrived ones on, land results, expire. Returns `s` itself when nothing changed. */
export function stepKbLife(s: KbLife, now: number): KbLife {
	let changed = false;
	let lastStartAt = s.lastStartAt;
	const pulses: KbPulse[] = [];
	let flights: KbFlight[] = [];
	const inAir = () => flights.filter((f) => f.stage !== "queued").length;
	// First phases that need no capacity, in order; queued ones last so the cap sees the real count.
	const rest: KbFlight[] = [];
	for (const f of s.flights) {
		let n = f;
		if (n.stage === "travel" && now >= n.endAt) n = { ...n, stage: "wait", at: n.endAt, endAt: n.endAt };
		if (n.stage === "wait") {
			if (n.result) {
				const landing = kbVisualOf(n.result.outcome) !== "none";
				const at = Math.max(now, n.at);
				n = landing ? { ...n, stage: "place", at, endAt: at + dur(s, KB_PLACE_MS) } : { ...n, stage: "fade", at, endAt: at + dur(s, KB_FADE_MS) };
			} else if (now - n.at > KB_WAIT_MAX_MS) n = { ...n, stage: "fade", at: now, endAt: now + dur(s, KB_FADE_MS) };
		}
		if ((n.stage === "place" || n.stage === "fade") && now >= n.endAt) {
			if (n.stage === "place" && n.result) pulses.push({ id: n.id, kind: kbVisualOf(n.result.outcome) === "ghost" ? "retire" : n.result.outcome === "create" ? "create" : "merge", outcome: n.result.outcome, ...(n.result.title ? { title: n.result.title } : {}), ...(n.result.sectionTitle ? { sectionTitle: n.result.sectionTitle } : {}), ...(n.result.entryId ? { entryId: n.result.entryId } : {}), ...(n.result.domain ?? n.domain ? { domain: (n.result.domain ?? n.domain)! } : {}), ...(n.result.section ? { section: n.result.section } : {}), ...(n.result.sectionPath?.length ? { sectionPath: n.result.sectionPath } : {}), at: n.endAt });
			changed = true;
			continue; // flight over
		}
		if (n !== f) changed = true;
		(n.stage === "queued" ? rest : flights).push(n);
	}
	for (const f of rest) {
		if (inAir() < KB_MAX_FLIGHTS && now - lastStartAt >= KB_STAGGER_MS) {
			flights.push({ ...f, stage: "travel", at: now, endAt: now + dur(s, KB_TRAVEL_MS) });
			lastStartAt = now;
			changed = true;
			// a zero-length travel (reduced motion) arrives at once
			const last = flights[flights.length - 1]!;
			if (last.endAt <= now) flights[flights.length - 1] = { ...last, stage: "wait", at: now };
		} else flights.push(f);
	}
	const topics = s.topics.filter((t) => now - t.born < KB_TOPIC_TTL_MS);
	if (topics.length !== s.topics.length) changed = true;
	const curator: Record<string, number> = {};
	for (const [k, at] of Object.entries(s.curator)) if (now - at < KB_CURATOR_TTL_MS) curator[k] = at;
	if (Object.keys(curator).length !== Object.keys(s.curator).length) changed = true;
	const allPulses = [...s.pulses, ...pulses].filter((p) => kbNerveState(p, now, s.reduced).phase !== "done");
	if (allPulses.length !== s.pulses.length + pulses.length || pulses.length > 0) changed = true;
	if (!changed) return s;
	// flights keep arrival order (a started flight keeps its place among the others)
	const order = new Map(s.flights.map((f, i) => [f.id + "\u0000" + f.queuedAt, i]));
	flights.sort((a, b) => (order.get(a.id + "\u0000" + a.queuedAt) ?? 0) - (order.get(b.id + "\u0000" + b.queuedAt) ?? 0));
	return { ...s, now, flights, topics, curator, pulses: allPulses, lastStartAt };
}

/**
 * How fast the frame loop must run for the KB life: "fast" only while something travels, places, fades, pulses or a ring fill eases;
 * "float" (the low idle rate) while flights only wait or queue and the curator only shimmers; "none" once everything has settled.
 * `now` is the same wall clock the events and stepKbLife use.
 */
export function kbLifeRate(s: KbLife, now: number): "none" | "float" | "fast" {
	if (s.reduced) return "none";
	if (s.pulses.length > 0) return "fast";
	for (const w of Object.values(s.wolves)) if (now - w.changedAt < KB_FILL_EASE_MS) return "fast";
	let slow = Object.keys(s.curator).length > 0;
	for (const f of s.flights) {
		if (f.stage === "travel" || f.stage === "place" || f.stage === "fade") return "fast";
		slow = true; // queued or waiting at the curator
	}
	return slow ? "float" : "none";
}

/** True while something is moving or fading (a frame loop is worth running). */
export const kbLifeBusy = (s: KbLife, now: number): boolean => kbLifeRate(s, now) !== "none";

/** The curator shimmers while it works a topic (curate-start) or a flight is waiting at it. */
export const curatorBusy = (s: KbLife): boolean => Object.keys(s.curator).length > 0 || s.flights.some((f) => f.stage === "wait" && !f.result);

export type KbVisual = "grow" | "ring" | "ghost" | "none";
/** The filing visual of a curator outcome: a create grows in, an update / merge pulses a ring, a retire turns into a fading dashed ghost; reject / parked file nothing. */
export function kbVisualOf(outcome: string): KbVisual {
	if (outcome === "create") return "grow";
	if (outcome === "merge" || outcome === "update" || outcome === "supersede") return "ring";
	if (outcome === "retire" || outcome === "retired") return "ghost";
	return "none";
}

const OUTCOME_WORD: Record<string, string> = { create: "created", merge: "merged", update: "updated", supersede: "superseded", retire: "retired", retired: "retired", reject: "rejected", parked: "parked" };
/** The one-line hover summary of a filed entry or a flying item: "Title · outcome · domain › section". Missing parts are left out. */
export function kbHoverText(x: { title?: string; outcome: string; domain?: string; sectionTitle?: string }): string {
	const where = x.domain ? (x.sectionTitle ? `${x.domain} › ${x.sectionTitle}` : x.domain) : "";
	return [x.title || "Entry", OUTCOME_WORD[x.outcome] ?? x.outcome, where].filter(Boolean).join(" · ");
}

/** The wolf's gathered topics in slot order (for drawing them beside it). */
export const topicsOf = (s: KbLife, wolf: string): KbTopic[] => s.topics.filter((t) => t.wolf === wolf);
