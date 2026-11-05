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

/** Spelling-tolerant outcome (ledgers and older receipts say created/merged/updated/rejected); anything unknown is `unclassified`. */
export function decisionOutcome(raw: string | null | undefined): KbDecisionOutcome {
	switch ((raw ?? "").trim().toLowerCase()) {
		case "create":
		case "created":
			return "create";
		case "merge":
		case "merged":
		case "updated":
			return "merge";
		case "unchanged":
			return "unchanged";
		case "reject":
		case "rejected":
			return "reject";
		case "parked":
		case "park":
			return "parked";
		default:
			return "unclassified";
	}
}

/** The live view state: the fetched response plus whether a sweep is in flight (sweep_started … sweep_finished). */
export interface KbActivityState {
	data: KbActivityResponse;
	sweeping: boolean;
}

export function initialActivityState(data: KbActivityResponse): KbActivityState {
	return { data, sweeping: data.sweep?.running === true };
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

/** Append a further page, dropping rows already present (by id); totals, counts and the cursor come from the newer page. */
export function mergeDecisionPages(prev: KbActivityResponse["decisions"], next: KbActivityResponse["decisions"]): KbActivityResponse["decisions"] {
	const seen = new Set(prev.items.map((d) => d.id));
	const items = [...prev.items, ...next.items.filter((d) => !seen.has(d.id))];
	const out: KbActivityResponse["decisions"] = { items, total: next.total, counts: next.counts };
	if (next.nextCursor) out.nextCursor = next.nextCursor;
	return out;
}

// ── changes ─────────────────────────────────────────────────────────────────

export const CHANGE_LABEL: Record<KbActivityChange["action"], string> = { create: "created", merge: "merged", supersede: "superseded", retire: "retired" };

export interface ChangeColumn {
	domain: string;
	rows: { key: string; at: string; action: KbActivityChange["action"]; label: string; entryId: string; title: string; wolf?: string }[];
}

/** One column per domain (by name), the latest 10 each, newest first. */
export function changeColumns(data: KbActivityResponse, perDomain: number = KB_ACTIVITY_CHANGES_PER_DOMAIN): ChangeColumn[] {
	return [...data.changes.domains]
		.sort((a, b) => a.domain.localeCompare(b.domain))
		.map((d) => ({
			domain: d.domain,
			rows: [...d.items]
				.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
				.slice(0, perDomain)
				.map((c) => {
					const row: ChangeColumn["rows"][number] = { key: `${c.at}/${c.entryId}/${c.action}`, at: c.at, action: c.action, label: CHANGE_LABEL[c.action], entryId: c.entryId, title: c.title || c.entryId };
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
 * Optimistic fold of one hub event. sweep_started → sweeping; sweep_item → one fewer pending for that wolf and a provisional decision row
 * (`item.decision` wins over `item.outcome`: a post-commit failure reports outcome `parked` with the committed decision); sweep_finished →
 * not sweeping. Anything else returns the same state. The refetch that follows sweep_finished replaces the provisional rows.
 */
export function applyHubEvent(state: KbActivityState, frame: KbHubFrame): KbActivityState {
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
			const row: KbDecision = { id, at: f.at, from: f.from, denTopicId: f.denTopicId, hash: "", outcome };
			const entryId = decision?.entryId ?? f.entryId;
			if (entryId) row.entryId = entryId;
			if (decision?.reason) row.reason = decision.reason;
			if (decision?.routing) row.routing = decision.routing;
			let removed = false;
			const wolves = d.incoming.wolves.map((w) => {
				if (w.wolf !== f.from || w.pending === 0) return w;
				removed = true;
				const items = w.items.filter((i) => i.denTopicId !== f.denTopicId);
				const next = { ...w, pending: dec(w.pending), items };
				if (next.pending === 0) delete next.oldestAgeMs;
				return next;
			});
			return {
				...state,
				sweeping: true,
				data: {
					...d,
					incoming: { total: removed ? dec(d.incoming.total) : d.incoming.total, wolves },
					decisions: {
						...d.decisions,
						items: [row, ...d.decisions.items],
						total: d.decisions.total + 1,
						counts: { ...d.decisions.counts, [outcome]: d.decisions.counts[outcome] + 1 },
					},
				},
			};
		}
		default:
			return state;
	}
}
