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
	const next = initialActivityState(data, scope);
	if (!data.sweep && prev) next.sweeping = prev.sweeping;
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

/** True when a frame means "the ledger moved or may have: refetch" (sweep_finished, kb.changed, resync). */
export function needsRefetch(frame: KbHubFrame): boolean {
	return frame.type === "sweep_finished" || frame.type === "kb.changed" || frame.type === "resync";
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
		case "sweep_started":
			return state.sweeping ? state : { ...state, sweeping: true };
		case "sweep_finished":
			return state.sweeping ? { ...state, sweeping: false } : state;
		case "sweep_item": {
			const f = frame as Extract<HubEvent, { type: "sweep_item" }>;
			if (typeof f.from !== "string" || typeof f.denTopicId !== "string") return state;
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
