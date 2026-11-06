/**
 * THE KB ACTIVITY MODEL (pure): the hub curator's activity page. Outcome labels, incoming-by-wolf grouping, decision rows and
 * filters, routing detail text, per-domain change columns, and the live fold of hub sweep_* events over a KbActivityResponse.
 * Browser-safe; no I/O. The ledger (what GET /v1/kb/activity returns) is the truth: events only add provisional rows until the refetch.
 */

import type { HubEvent, KbActivityChange, KbActivityResponse, KbDecision, KbDecisionOutcome } from "@wolfpack/client";

export type { KbActivityChange, KbActivityResponse, KbDecision, KbDecisionOutcome };

export type KbActivityRouting = KbDecision["routing"];
export type KbActivityBad = NonNullable<KbActivityResponse["incoming"]["bad"]>[number];
export type KbActivityDomain = NonNullable<KbActivityResponse["domains"]>[number];
export type KbActivityIncomingWolf = KbActivityResponse["incoming"]["wolves"][number];
export type KbActivitySince = "7d" | "30d" | "all";
export const KB_ACTIVITY_SINCE: readonly KbActivitySince[] = ["7d", "30d", "all"];
/** Per-domain page ('show all'). */
export const KB_ACTIVITY_PAGE = 50;
/** The overview request. Blocks read the hub's per-domain `recent`, so this list only feeds provisional rows and an older hub. */
export const KB_ACTIVITY_OVERVIEW = 50;
/** Rows shown per domain block before 'show all'. */
export const KB_ACTIVITY_DOMAIN_ROWS = 8;
export const KB_ACTIVITY_ATTENTION_ROWS = 20;
export const KB_ACTIVITY_CHANGES_PER_DOMAIN = 10;

/** Display order of the outcome filter. */
export const DECISION_OUTCOMES: readonly KbDecisionOutcome[] = ["create", "merge", "unchanged", "reject", "parked", "unclassified"];

export const DECISION_LABEL: Record<KbDecisionOutcome, string> = {
	create: "created",
	merge: "merged",
	unchanged: "unchanged",
	reject: "rejected",
	parked: "parked",
	unclassified: "unclassified",
};

/** Spelling-tolerant outcome (past-tense spellings); anything unknown is `unclassified`. */
export function decisionOutcome(raw: string | null | undefined): KbDecisionOutcome {
	switch ((raw ?? "").trim().toLowerCase()) {
		case "create":
		case "created":
			return "create";
		case "merge":
		case "merged":
			return "merge";
		case "unchanged":
			return "unchanged";
		case "reject":
		case "rejected":
			return "reject";
		case "parked":
			return "parked";
		default:
			return "unclassified";
	}
}

/** The live view state: the fetched response plus whether a sweep is in flight (sweep_started … sweep_finished). */
export interface KbActivityState {
	data: KbActivityResponse;
	sweeping: boolean;
	/** The range and domain the data was fetched for: provisional rows outside them are not added. */
	scope?: KbActivityScope;
	/**
	 * Items whose sweep_item was seen (key from + topic), and whether the sweep finished: a refetch issued BEFORE those events can land
	 * after them carrying `sweep.current` again, so reconcileActivity drops a `current` that these say is over. Both are cleared entirely
	 * by the next sweep_started and by resync (a reconnect may have missed frames); sweep_progress also lifts `ended` for its item.
	 * The cap of 20 is enough: a hub tick handles one item, so only the last few ended items can still have a refetch in flight.
	 */
	ended?: string[];
	idle?: boolean;
}

export interface KbActivityScope {
	/** "7d" | "30d" | "all" | an ISO timestamp. */
	since?: string;
	domain?: string;
}

export function initialActivityState(data: KbActivityResponse, scope?: KbActivityScope): KbActivityState {
	return { data, sweeping: data.sweep?.running === true, ...(scope ? { scope } : {}) };
}

const DAY_MS = 86_400_000;

/** The earliest time a decision may have to belong to `since` (null: no lower bound, or an unparseable value). */
export function sinceCutoff(since: string | undefined, now: number = Date.now()): number | null {
	if (!since || since === "all") return null;
	if (since === "7d") return now - 7 * DAY_MS;
	if (since === "30d") return now - 30 * DAY_MS;
	const t = Date.parse(since);
	return Number.isNaN(t) ? null : t;
}

/** A refetch replaces the data (provisional rows go); the sweeping flag carries over when the response does not say. */
export function reconcileActivity(prev: KbActivityState | null, data: KbActivityResponse, scope?: KbActivityScope): KbActivityState {
	let d = data;
	const cur = data.sweep?.current;
	// The response's own `running: true` does not override `idle` (it may predate the sweep_finished); sweep_started / resync clear it.
	if (cur && prev && (prev.idle || prev.ended?.includes(itemKey(cur)))) d = { ...data, sweep: withoutCurrent(data.sweep!) }; // a stale response: that item already ended
	const next = initialActivityState(d, scope);
	if (!data.sweep && prev) next.sweeping = prev.sweeping;
	if (prev?.ended) next.ended = prev.ended;
	if (prev?.idle) next.idle = true;
	return next;
}

// ── incoming ────────────────────────────────────────────────────────────────

/** Wolves with something waiting (or bad files), most pending first, then oldest wait, then name. */
export function groupIncoming(data: KbActivityResponse): KbActivityIncomingWolf[] {
	return data.incoming.wolves
		.filter((w) => w.pending > 0 || (w.bad ?? 0) > 0)
		.sort((a, b) => b.pending - a.pending || (b.oldestAgeMs ?? 0) - (a.oldestAgeMs ?? 0) || a.wolf.localeCompare(b.wolf));
}

// ── decisions ───────────────────────────────────────────────────────────────

export interface DecisionRow {
	id: string;
	at: string;
	wolf: string;
	denTopicId: string;
	outcome: KbDecisionOutcome;
	label: string;
	entryId?: string;
	reason?: string;
	routing?: NonNullable<KbActivityRouting>;
	/** Earlier decisions this one replaced (e.g. parked, then merge). */
	superseded: number;
	/** Built from a live sweep_item and not yet confirmed by the ledger. */
	provisional: boolean;
}

export const PROVISIONAL_PREFIX = "live:";

export function decisionRows(decisions: readonly KbDecision[]): DecisionRow[] {
	return decisions.map((d) => {
		const row: DecisionRow = {
			id: d.id,
			at: d.at,
			wolf: d.from,
			denTopicId: d.denTopicId,
			outcome: d.outcome,
			label: DECISION_LABEL[d.outcome] ?? d.outcome,
			superseded: d.superseded ?? 0,
			provisional: d.id.startsWith(PROVISIONAL_PREFIX),
		};
		if (d.entryId) row.entryId = d.entryId;
		if (d.reason) row.reason = d.reason;
		if (d.routing) row.routing = d.routing;
		return row;
	});
}

/** Routing detail lines for the expandable row: route + band, top-3 candidates, subject, confirm, warning. Empty when there is no routing. */
export function routingSummary(routing: KbActivityRouting): string[] {
	if (!routing) return [];
	const lines: string[] = [`route: ${routing.route}${routing.band ? ` · band ${routing.band}` : ""}${routing.target ? ` → ${routing.target}` : ""}`];
	if (routing.candidates.length > 0) {
		const top = [...routing.candidates].sort((a, b) => b.score - a.score).slice(0, 3);
		lines.push(`candidates: ${top.map((c) => `${c.id} ${c.score.toFixed(2)}`).join(", ")}`);
	}
	if (routing.subject) lines.push(`subject: ${routing.subject.match} (${routing.subject.valid ? "valid" : "invalid"}${routing.subject.reason ? `: ${routing.subject.reason}` : ""})`);
	if (routing.confirm) {
		const c = routing.confirm;
		lines.push(`confirm: ${c.candidate} ${c.score.toFixed(2)} · ${c.merge ? "merge" : "no merge"} (${c.valid ? "valid" : "invalid"}${c.reason ? `: ${c.reason}` : ""})`);
	}
	if (routing.warning) lines.push(`warning: ${routing.warning}`);
	return lines;
}

/**
 * Append a further page, dropping rows already present (by id). The cursor is the further page's. `total` and `counts` come from whichever
 * snapshot is newer: pass each side's `generatedAt` (`prevAt` = the refetch the loaded data came from, `nextAt` = the Load more page's);
 * the Load more page wins only when it is strictly newer, and without timestamps the loaded data stands.
 */
export function mergeDecisionPages(prev: KbActivityResponse["decisions"], next: KbActivityResponse["decisions"], prevAt?: string, nextAt?: string): KbActivityResponse["decisions"] {
	const seen = new Set(prev.items.map((d) => d.id));
	const items = [...prev.items, ...next.items.filter((d) => !seen.has(d.id))];
	const tp = prevAt === undefined ? NaN : Date.parse(prevAt);
	const tn = nextAt === undefined ? NaN : Date.parse(nextAt);
	const nextIsNewer = !Number.isNaN(tp) && !Number.isNaN(tn) && tn > tp;
	const out: KbActivityResponse["decisions"] = { items, total: nextIsNewer ? next.total : prev.total, counts: nextIsNewer ? next.counts : prev.counts };
	if (next.nextCursor) out.nextCursor = next.nextCursor;
	return out;
}

// ── domain blocks ───────────────────────────────────────────────────────────

export const CHANGE_LABEL: Record<KbActivityChange["action"], string> = { create: "created", merge: "merged", supersede: "superseded", retire: "retired" };
const MARK: Record<string, string> = { create: "+", merge: "~", unchanged: "=", reject: "×", parked: "…", unclassified: "?", supersede: "~", retire: "−" };

/** Newest first; an unparseable time compares equal, so the hub's order stands (the sort is stable). */
function timeDesc(a: string, b: string): number {
	const d = Date.parse(b) - Date.parse(a);
	return Number.isNaN(d) ? 0 : d;
}

/** One line of a domain block: a decision (merged with the entry change it produced) or an unmatched change. */
export interface FeedRow {
	key: string;
	at: string;
	/** "+" created, "~" merged, "×" rejected, ... */
	mark: string;
	label: string;
	/** The outcome, for decisions. */
	outcome?: KbDecisionOutcome;
	/** Entry title (or id / topic id when there is none). */
	title: string;
	entryId?: string;
	wolf?: string;
	denTopicId?: string;
	superseded: number;
	provisional: boolean;
}

/** Further pages the view loaded for one domain ('show all'). */
export interface DomainExtra {
	items: KbDecision[];
	nextCursor?: string;
	/** The changes of that fetch (so a deep page still has its entry rows). */
	changes: KbActivityChange[];
}

export interface DomainBlock {
	domain: string;
	/** Undefined when the hub is older than this console (no domain summary): shown as "–", never as a fake zero. */
	entries: number | undefined;
	waiting: number | undefined;
	lastChangeAt?: string;
	contributors: { wolf: string; count: number }[];
	rows: FeedRow[];
	/** Decisions in range for this domain (any outcome). */
	decided: number;
	/** 'show all' is useful: more decisions exist than the rows shown, or a further page is loaded and has a cursor. */
	more: boolean;
	expanded: boolean;
}

/** True when the hub sent no per-domain summary: it is older than this console. */
export function hubIsOlder(data: KbActivityResponse): boolean {
	return data.domains === undefined;
}

type Summary = Omit<KbActivityDomain, "entries" | "waiting"> & { entries?: number; waiting?: number };

/** The domains of a response. An older hub sends no `domains` and no per-decision domain, so the fallback only knows domains seen in `changes` (change rows only; counts unknown). */
function domainSummaries(data: KbActivityResponse): Summary[] {
	if (data.domains) return data.domains;
	const names = new Set<string>();
	for (const c of data.changes.domains) names.add(c.domain);
	for (const d of data.decisions.items) if (d.domain) names.add(d.domain);
	return [...names].sort().map((domain) => {
		const counts = new Map<string, number>();
		for (const d of data.decisions.items) if (d.domain === domain) counts.set(d.from, (counts.get(d.from) ?? 0) + 1);
		return { domain, contributors: [...counts].map(([wolf, count]) => ({ wolf, count })) };
	});
}

const matches = (c: KbActivityChange, d: KbDecision): boolean => c.from !== undefined && c.from === d.from && c.denTopicId === d.denTopicId;

export function domainBlocks(data: KbActivityResponse, extras: Readonly<Record<string, DomainExtra>> = {}, perDomain: number = KB_ACTIVITY_DOMAIN_ROWS): DomainBlock[] {
	return domainSummaries(data).map((sum) => {
		const extra = extras[sum.domain];
		const seen = new Set<string>();
		const decisions: KbDecision[] = [];
		// The hub's per-domain `recent` is the base; the overall page adds live (provisional) rows and, for an older hub, everything.
		for (const d of [...(sum.recent ?? []), ...data.decisions.items, ...(extra?.items ?? [])]) {
			if (d.domain !== sum.domain || seen.has(d.id)) continue;
			seen.add(d.id);
			decisions.push(d);
		}
		const changes = [...(data.changes.domains.find((c) => c.domain === sum.domain)?.items ?? []), ...(extra?.changes ?? [])];
		const rows: FeedRow[] = decisions.map((d) => {
			const row: FeedRow = {
				key: d.id,
				at: d.at,
				mark: MARK[d.outcome] ?? "?",
				label: DECISION_LABEL[d.outcome] ?? d.outcome,
				outcome: d.outcome,
				title: d.title || d.entryId || d.denTopicId,
				wolf: d.from,
				denTopicId: d.denTopicId,
				superseded: d.superseded ?? 0,
				provisional: d.id.startsWith(PROVISIONAL_PREFIX),
			};
			if (d.entryId) row.entryId = d.entryId;
			return row;
		});
		const keys = new Set<string>();
		changes.forEach((c, i) => {
			if (decisions.some((d) => matches(c, d))) return; // one row per item
			const key = `${i}/${c.at}/${c.entryId}/${c.action}`;
			if (keys.has(`${c.at}/${c.entryId}/${c.action}`)) return;
			keys.add(`${c.at}/${c.entryId}/${c.action}`);
			const row: FeedRow = { key, at: c.at, mark: MARK[c.action] ?? "·", label: CHANGE_LABEL[c.action], title: c.title || c.entryId, entryId: c.entryId, superseded: 0, provisional: false };
			if (c.from) row.wolf = c.from;
			rows.push(row);
		});
		rows.sort((a, b) => timeDesc(a.at, b.at));
		const decided = sum.decided ?? sum.contributors.reduce((n, c) => n + c.count, 0);
		const expanded = extra !== undefined;
		const shown = expanded ? rows : rows.slice(0, perDomain);
		const out: DomainBlock = {
			domain: sum.domain,
			entries: sum.entries,
			waiting: sum.waiting,
			contributors: sum.contributors,
			rows: shown,
			decided,
			more: expanded ? extra.nextCursor !== undefined : decided > shown.filter((r) => r.outcome !== undefined).length,
			expanded,
		};
		if (sum.lastChangeAt) out.lastChangeAt = sum.lastChangeAt;
		return out;
	});
}

// ── needs attention ─────────────────────────────────────────────────────────

export interface AttentionItem {
	key: string;
	kind: "bad" | "decision";
	denTopicId?: string;
	domainHint?: string;
	reason: string;
	at: string;
	outcome?: KbDecisionOutcome;
}
export interface AttentionGroup {
	wolf: string;
	summary: string;
	count: number;
	items: AttentionItem[];
	/** More contributions than listed: the list is the latest ones. */
	truncated: boolean;
}

/**
 * Per wolf: the hub's totals over the whole range (rejected + parked + unclassified, plus quarantined files) and the latest items it
 * sent (decisions and bad files). Without the hub totals (older hub) it counts what is loaded, a lower bound.
 */
export function attentionGroups(data: KbActivityResponse): AttentionGroup[] {
	const items = new Map<string, AttentionItem[]>();
	const totals = new Map<string, number>();
	const add = (wolf: string, item: AttentionItem) => items.set(wolf, [...(items.get(wolf) ?? []), item]);
	const seen = new Set<string>();
	for (const b of data.incoming.bad ?? []) {
		const key = `bad/${b.wolf}/${b.id ?? `${b.denTopicId ?? ""}/${b.at}/${b.reason}`}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const item: AttentionItem = { key, kind: "bad", reason: b.reason, at: b.at };
		if (b.denTopicId) item.denTopicId = b.denTopicId;
		if (b.domainHint) item.domainHint = b.domainHint;
		add(b.wolf, item);
	}
	const decisions = data.attention ? data.attention.flatMap((a) => a.items) : data.decisions.items;
	for (const d of decisions) {
		if (d.outcome !== "reject" && d.outcome !== "parked" && d.outcome !== "unclassified") continue;
		if (seen.has(d.id)) continue;
		seen.add(d.id);
		const item: AttentionItem = { key: d.id, kind: "decision", denTopicId: d.denTopicId, reason: d.reason ?? DECISION_LABEL[d.outcome], at: d.at, outcome: d.outcome };
		if (d.domain) item.domainHint = d.domain;
		add(d.from, item);
	}
	// An older hub has no totals: the loaded rows are a lower bound, so say so when more pages exist.
	const lowerBound = !data.attention && data.decisions.nextCursor !== undefined;
	if (data.attention) for (const a of data.attention) totals.set(a.wolf, a.reject + a.parked + a.unclassified + a.bad);
	return [...items.keys(), ...totals.keys()]
		.filter((w, i, all) => all.indexOf(w) === i)
		.map((wolf) => {
			const sorted = (items.get(wolf) ?? []).sort((a, b) => timeDesc(a.at, b.at));
			const n = Math.max(totals.get(wolf) ?? 0, sorted.length);
			const reasons = new Set(sorted.map((i) => i.reason));
			const noun = n === 1 ? "contribution" : "contributions";
			const summary = reasons.size === 1 && sorted.length === n ? `${n} ${noun}: ${sorted[0]!.reason}` : `${n} ${noun} need attention`;
			return { wolf, count: n, items: sorted, summary: lowerBound ? `${n}+ contributions need attention` : summary, truncated: lowerBound || sorted.length < n };
		})
		.filter((g) => g.count > 0)
		.sort((a, b) => b.count - a.count || a.wolf.localeCompare(b.wolf));
}

/** Why the decision feed may be empty: the curator is off, or the ledger holds no decision yet. */
export function curatorNote(data: KbActivityResponse): string | null {
	if (data.source.curator === "off") return "The hub curator is off, so nothing is being decided. Waiting contributions stay in the inbox.";
	if (!data.source.hasDecisions) return "The curator hasn't decided anything yet.";
	return null;
}

// ── time ────────────────────────────────────────────────────────────────────

export function kbAge(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 10) return "just now";
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** "3m ago" / "just now"; `now` injectable for tests. */
export function kbRelativeTime(iso: string, now: number = Date.now()): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	const age = kbAge(Math.max(0, now - t));
	return age === "just now" ? age : `${age} ago`;
}

// ── live fold ───────────────────────────────────────────────────────────────

/** A hub event frame as the browser receives it (only the fields this page reads). */
export type KbHubFrame = HubEvent | { type: string; [k: string]: unknown };

/**
 * True when a frame means "the ledger or the item in progress moved or may have: refetch" (sweep_started, sweep_item, sweep_finished,
 * kb.changed, resync). sweep_started / sweep_item matter for the Contributions list: the item in progress (sweep.current) only comes from the hub.
 */
export function needsRefetch(frame: KbHubFrame): boolean {
	return frame.type === "sweep_started" || frame.type === "sweep_item" || frame.type === "sweep_finished" || frame.type === "kb.changed" || frame.type === "resync";
}

const itemKey = (x: { from: string; denTopicId: string }): string => `${x.from}\u0000${x.denTopicId}`;
type Sweep = NonNullable<KbActivityResponse["sweep"]>;
function withoutCurrent(sw: Sweep): Sweep {
	const { current: _drop, ...rest } = sw;
	return rest;
}

const dec = (n: number): number => Math.max(0, n - 1);

/**
 * The identity of a contribution in the feed. A live sweep_item carries no hash, so live matching uses from + denTopicId only; if one topic
 * was resubmitted with a different hash the match can be coarse, and the refetch after sweep_finished corrects it.
 */
function sameContribution(a: { from: string; denTopicId: string }, b: { from: string; denTopicId: string }): boolean {
	return a.from === b.from && a.denTopicId === b.denTopicId;
}

/**
 * Optimistic fold of one hub event. sweep_started → sweeping; sweep_item → a provisional decision row (`item.decision` wins over
 * `item.outcome`: a post-commit failure reports outcome `parked` with the committed decision) and one fewer pending for that wolf (not for a
 * plain parked item, which stays pending; a parked item whose decision is a committed create/merge does leave it); sweep_finished → not sweeping. An item that already has a
 * row (same contribution) REPLACES it instead of counting twice. Rows outside the active range are not added. Anything else returns the same
 * state. The refetch that follows sweep_finished replaces the provisional rows.
 */
export function applyHubEvent(state: KbActivityState, frame: KbHubFrame, now: number = Date.now()): KbActivityState {
	switch (frame.type) {
		case "sweep_started": {
			// Narrow window: a refetch issued before item X's sweep_item that lands after the next sweep_started can briefly bring X back as
			// current (clearing `ended` here drops the guard). The next sweep_progress (the new item) or sweep_finished replaces/clears it.
			// A new sweep: nothing that ended before it can be stale any more (a resubmission of the same item may be in progress).
			if (!state.idle && !state.ended) return state.sweeping ? state : { ...state, sweeping: true };
			const { idle: _i, ended: _e, ...rest } = state;
			return { ...rest, sweeping: true };
		}
		case "resync": {
			// SSE reconnect: frames may have been missed, so earlier "ended / idle" knowledge is not trustworthy. The refetch decides.
			if (!state.idle && !state.ended) return state;
			const { idle: _i, ended: _e, ...rest } = state;
			return rest;
		}
		case "sweep_progress": {
			// the item in progress (or its route) changed: show it now, without a refetch
			const f = frame as Extract<HubEvent, { type: "sweep_progress" }>;
			if (typeof f.from !== "string" || typeof f.denTopicId !== "string" || typeof f.startedAt !== "number") return state;
			const current: NonNullable<Sweep["current"]> = { from: f.from, denTopicId: f.denTopicId, startedAt: f.startedAt };
			if (f.route) current.route = f.route;
			const { idle: _i, ...rest } = state;
			const ended = state.ended?.filter((k) => k !== itemKey(f));
			const next: KbActivityState = { ...rest, sweeping: true, data: { ...state.data, sweep: { ...(state.data.sweep ?? { running: true }), running: true, current } } };
			if (ended && ended.length > 0) next.ended = ended;
			else delete next.ended;
			return next;
		}
		case "sweep_finished": {
			const sw = state.data.sweep;
			const data = sw?.current ? { ...state.data, sweep: withoutCurrent(sw) } : state.data;
			return state.sweeping || data !== state.data || !state.idle ? { ...state, data, sweeping: false, idle: true } : state;
		}
		case "sweep_item": {
			const f = frame as Extract<HubEvent, { type: "sweep_item" }>;
			if (typeof f.from !== "string" || typeof f.denTopicId !== "string") return state;
			// The item ended: it is no longer in progress, whether or not the rest of this event is new (a duplicate or already-reconciled
			// event still clears it), and a response fetched before this event must not bring it back (state.ended, see reconcileActivity).
			const key = itemKey(f);
			if (state.data.sweep?.current && itemKey(state.data.sweep.current) === key) state = { ...state, data: { ...state.data, sweep: withoutCurrent(state.data.sweep) } };
			if (!state.ended?.includes(key)) state = { ...state, ended: [...(state.ended ?? []), key].slice(-20) };
			const d = state.data;
			const decision = f.decision;
			const outcome = decision ? decisionOutcome(decision.outcome) : decisionOutcome(f.outcome);
			const id = `${PROVISIONAL_PREFIX}${f.id}`;
			if (d.decisions.items.some((x) => x.id === id)) return state;

			// incoming: a plain parked item stays pending; but a parked item whose decision carries a committed create/merge (post-commit
			// failure) was decided, so it leaves the pending count. Match on from + denTopicId only (the event has no hash).
			let incoming = d.incoming;
			const committed = outcome === "create" || outcome === "merge" || outcome === "unchanged";
			if (f.outcome !== "parked" || committed) {
				let removed = false;
				const wolves = d.incoming.wolves.map((w) => {
					if (w.wolf !== f.from || w.pending === 0) return w;
					removed = true;
					const at = w.items.findIndex((i) => i.denTopicId === f.denTopicId);
					const items = at < 0 ? w.items : w.items.filter((_, k) => k !== at);
					const next = { ...w, pending: dec(w.pending), items };
					if (next.pending === 0) delete next.oldestAgeMs;
					return next;
				});
				if (removed) incoming = { total: dec(d.incoming.total), wolves };
			}

			// decisions: only inside the fetched range (a domain filter cannot be checked on a provisional row, so it adds none)
			const cutoff = sinceCutoff(state.scope?.since, now);
			const t = Date.parse(f.at);
			const outside = state.scope?.domain !== undefined || (cutoff !== null && !Number.isNaN(t) && t < cutoff);
			if (outside) return { ...state, sweeping: true, data: { ...d, incoming } };

			const row: KbDecision = { id, at: f.at, from: f.from, denTopicId: f.denTopicId, hash: "", outcome };
			const entryId = decision?.entryId ?? f.entryId;
			if (entryId) row.entryId = entryId;
			const known = d.decisions.items.find((x) => sameContribution(x, row) && x.domain) ?? (entryId ? d.decisions.items.find((x) => x.entryId === entryId && x.domain) : undefined);
			const dom = known?.domain ?? (entryId ? d.changes.domains.find((c) => c.items.some((i) => i.entryId === entryId))?.domain : undefined);
			// No known domain (a new contribution): the row is not shown in any block until the refetch that sweep_finished triggers.
			if (dom) row.domain = dom;
			if (decision?.reason) row.reason = decision.reason;
			if (decision?.routing) row.routing = decision.routing;

			const existing = d.decisions.items.findIndex((x) => sameContribution(x, { from: row.from, denTopicId: row.denTopicId }));
			const counts = { ...d.decisions.counts };
			let items: KbDecision[];
			let total = d.decisions.total;
			if (existing >= 0) {
				const old = d.decisions.items[existing]!;
				counts[old.outcome] = dec(counts[old.outcome]);
				items = [row, ...d.decisions.items.filter((_, k) => k !== existing)];
			} else {
				items = [row, ...d.decisions.items];
				total += 1;
			}
			counts[outcome] += 1;
			return { ...state, sweeping: true, data: { ...d, incoming, decisions: { ...d.decisions, items, total, counts } } };
		}
		default:
			return state;
	}
}

// ── contributions list ──────────────────────────────────────────────────────

/** Decided create / merge / unchanged items stay listed this long. */
export const KB_CONTRIBUTION_DECIDED_MS = 15 * 60_000;
/** Rejected and parked items stay listed longer: they need a look. */
export const KB_CONTRIBUTION_ATTENTION_MS = 24 * 3_600_000;
export const KB_CONTRIBUTION_ROWS = 30;
/** Of the cap, up to this many rows are kept for rejected / parked / unclassified items when a busy lane would push them out. */
export const KB_CONTRIBUTION_ATTENTION_RESERVE = 10;

export type ContributionState = "queued" | "running" | "decided";

export interface ContributionRow {
	key: string;
	state: ContributionState;
	wolf: string;
	denTopicId: string;
	domain?: string;
	/** Epoch ms: arrival (queued), start (running) or decision time (decided). Age = now - at. */
	at: number;
	/** Running: the curator's current route, e.g. "merge into kb-x (9391 chars)". */
	route?: string;
	/** Decided. */
	outcome?: KbDecisionOutcome;
	label: string;
	entryId?: string;
	reason?: string;
}

const STATE_ORDER: Record<ContributionState, number> = { running: 0, queued: 1, decided: 2 };

/**
 * The live Contributions list: one row per incoming item, by wolf + topic. Running = the hub's `sweep.current` (absent on an older hub or
 * when idle: then nothing is running); queued = waiting in the lane; decided = a recent decision (create / merge / unchanged for 15 minutes,
 * reject / parked / unclassified for 24 hours; a parked item still in the lane stays). A decision older than the item's arrival (a resubmission) does not
 * hide the queued item. Order: running, queued (oldest first), decided (newest first), capped.
 */
export function contributionRows(data: KbActivityResponse, now: number = Date.now(), cap: number = KB_CONTRIBUTION_ROWS): ContributionRow[] {
	return contributionList(data, now, cap).rows;
}

const needsLook = (r: ContributionRow): boolean => r.state === "decided" && (r.outcome === "reject" || r.outcome === "parked" || r.outcome === "unclassified");

/** The rows plus how many were cut by the cap. Up to KB_CONTRIBUTION_ATTENTION_RESERVE rows of the cap are kept for items that need a look. */
export function contributionList(data: KbActivityResponse, now: number = Date.now(), cap: number = KB_CONTRIBUTION_ROWS): { rows: ContributionRow[]; more: number } {
	const base = Date.parse(data.generatedAt);
	const ref = Number.isNaN(base) ? now : base;
	const id = (w: string, t: string) => `${w}\u0000${t}`;
	const rows = new Map<string, ContributionRow>();

	const queued = new Map<string, ContributionRow>();
	for (const w of data.incoming.wolves)
		for (const i of w.items) {
			const row: ContributionRow = { key: id(w.wolf, i.denTopicId), state: "queued", wolf: w.wolf, denTopicId: i.denTopicId, at: ref - i.ageMs, label: "queued" };
			if (i.domain) row.domain = i.domain;
			queued.set(row.key, row);
		}

	const seen = new Set<string>();
	const decisions: KbDecision[] = [];
	for (const d of [...(data.domains ?? []).flatMap((x) => x.recent ?? []), ...data.decisions.items]) {
		if (seen.has(d.id)) continue;
		seen.add(d.id);
		decisions.push(d);
	}
	decisions.sort((a, b) => timeDesc(a.at, b.at));
	for (const d of decisions) {
		const key = id(d.from, d.denTopicId);
		if (rows.has(key)) continue; // newest decision per item
		const t = Date.parse(d.at);
		if (Number.isNaN(t)) continue;
		const q = queued.get(key);
		if (q && q.at > t) continue; // resubmitted after this decision
		const attention = d.outcome === "reject" || d.outcome === "parked" || d.outcome === "unclassified";
		if (now - t > (attention ? KB_CONTRIBUTION_ATTENTION_MS : KB_CONTRIBUTION_DECIDED_MS) && !(q && d.outcome === "parked")) continue;
		const row: ContributionRow = { key, state: "decided", wolf: d.from, denTopicId: d.denTopicId, at: t, outcome: d.outcome, label: DECISION_LABEL[d.outcome] ?? d.outcome };
		if (d.domain ?? q?.domain) row.domain = (d.domain ?? q?.domain)!;
		if (d.entryId) row.entryId = d.entryId;
		if (d.reason) row.reason = d.reason;
		rows.set(key, row);
	}

	for (const [k, q] of queued) if (!rows.has(k)) rows.set(k, q);

	const cur = data.sweep?.current;
	if (cur && typeof cur.from === "string" && typeof cur.denTopicId === "string") {
		const key = id(cur.from, cur.denTopicId);
		const known = rows.get(key) ?? queued.get(key);
		const row: ContributionRow = { key, state: "running", wolf: cur.from, denTopicId: cur.denTopicId, at: cur.startedAt, label: "in progress" };
		if (known?.domain) row.domain = known.domain;
		if (cur.route) row.route = cur.route;
		rows.set(key, row);
	}

	const all = [...rows.values()].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.state === "decided" ? b.at - a.at : a.at - b.at));
	if (all.length <= cap) return { rows: all, more: 0 };
	// Over the cap: fill with the other rows first, but leave room for the ones that need a look; keep the display order.
	const att = all.filter(needsLook);
	const reserve = Math.min(att.length, KB_CONTRIBUTION_ATTENTION_RESERVE, cap);
	const keep = new Set<ContributionRow>(att.slice(0, reserve));
	for (const r of all) if (keep.size < cap && !needsLook(r)) keep.add(r);
	for (const r of att) if (keep.size < cap) keep.add(r);
	return { rows: all.filter((r) => keep.has(r)), more: all.length - keep.size };
}
