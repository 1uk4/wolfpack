/**
 * THE KB ACTIVITY MODEL (pure): the hub curator's activity page. Outcome labels, incoming-by-wolf grouping, decision rows and
 * filters, routing detail text, per-domain change columns, and the live fold of hub sweep_* events over a KbActivityResponse.
 * Browser-safe; no I/O. The ledger (what GET /v1/kb/activity returns) is the truth: events only add provisional rows until the refetch.
 */

import type { HubEvent, KbActivityChange, KbActivityResponse, KbDecision, KbDecisionOutcome } from "@wolfpack/client";

export type { KbActivityChange, KbActivityResponse, KbDecision, KbDecisionOutcome };

export type KbActivityRouting = KbDecision["routing"];
export type KbActivityIncomingWolf = KbActivityResponse["incoming"]["wolves"][number];
export type KbActivitySince = "7d" | "30d" | "all";
export const KB_ACTIVITY_SINCE: readonly KbActivitySince[] = ["7d", "30d", "all"];
export const KB_ACTIVITY_PAGE = 50;
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

/**
 * A first-page refetch folded into the state: the fresh first page replaces the head (provisional rows go), the ledger rows already
 * loaded beyond it stay (and the cursor of the deepest page with them). If the fresh page does not overlap the loaded rows (more than a page
 * of new decisions arrived), paging restarts from the fresh page so the list never has a hole.
 */
export function refreshDecisions(prev: KbActivityResponse["decisions"] | null, fresh: KbActivityResponse["decisions"]): KbActivityResponse["decisions"] {
	const ledger = prev ? prev.items.filter((d) => !d.id.startsWith(PROVISIONAL_PREFIX)) : [];
	const freshIds = new Set(fresh.items.map((d) => d.id));
	const overlap = ledger.some((d) => freshIds.has(d.id));
	if (!prev || ledger.length === 0 || !overlap) return fresh;
	const tail = ledger.filter((d) => !freshIds.has(d.id));
	if (tail.length === 0) return fresh;
	const out: KbActivityResponse["decisions"] = { items: [...fresh.items, ...tail], total: fresh.total, counts: fresh.counts };
	const cursor = prev.nextCursor;
	if (cursor) out.nextCursor = cursor;
	return out;
}

export function reconcileActivity(prev: KbActivityState | null, data: KbActivityResponse, scope?: KbActivityScope): KbActivityState {
	const next = initialActivityState(data, scope);
	if (prev && prev.scope?.since === scope?.since && prev.scope?.domain === scope?.domain) {
		next.data = { ...data, decisions: refreshDecisions(prev.data.decisions, data.decisions) };
	}
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

/** `outcome` "all" keeps everything. */
export function filterDecisions(rows: readonly DecisionRow[], outcome: KbDecisionOutcome | "all"): DecisionRow[] {
	return outcome === "all" ? [...rows] : rows.filter((r) => r.outcome === outcome);
}

/** Filter chips with counts, "all" first; outcomes with a zero count are kept (the owner sees what never happened). */
export function outcomeFilters(data: KbActivityResponse): { key: KbDecisionOutcome | "all"; label: string; count: number }[] {
	return [
		{ key: "all", label: "all", count: data.decisions.total },
		...DECISION_OUTCOMES.map((o) => ({ key: o, label: DECISION_LABEL[o], count: data.decisions.counts[o] })),
	];
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

// ── changes ─────────────────────────────────────────────────────────────────

export const CHANGE_LABEL: Record<KbActivityChange["action"], string> = { create: "created", merge: "merged", supersede: "superseded", retire: "retired" };

export interface ChangeColumn {
	domain: string;
	rows: { key: string; at: string; action: KbActivityChange["action"]; label: string; entryId: string; title: string; wolf?: string }[];
}

/** Newest first; an unparseable time compares equal, so the hub's order stands (the sort is stable). */
function timeDesc(a: string, b: string): number {
	const d = Date.parse(b) - Date.parse(a);
	return Number.isNaN(d) ? 0 : d;
}

/** One column per domain (by name), the latest 10 each, newest first. */
export function changeColumns(data: KbActivityResponse, perDomain: number = KB_ACTIVITY_CHANGES_PER_DOMAIN): ChangeColumn[] {
	return [...data.changes.domains]
		.sort((a, b) => a.domain.localeCompare(b.domain))
		.map((d) => ({
			domain: d.domain,
			rows: [...d.items]
				.sort((a, b) => timeDesc(a.at, b.at))
				.slice(0, perDomain)
				.map((c, i) => {
					const row: ChangeColumn["rows"][number] = { key: `${i}/${c.at}/${c.entryId}/${c.action}`, at: c.at, action: c.action, label: CHANGE_LABEL[c.action], entryId: c.entryId, title: c.title || c.entryId };
					if (c.from) row.wolf = c.from;
					return row;
				}),
		}));
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
