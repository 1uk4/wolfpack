/**
 * KB LIFE LOG (pure): the KB activity page's rows. One row per pipeline step, duplicates folded (same verb + same target/topic/wolf
 * within FOLD_WINDOW_MS become one row with a count), grouped by domain. Rows come from live pack.activity events and from the hub's
 * ledger history (seed rows); a seed row that the live feed already carries is dropped.
 */
import type { ActivityEvent } from "@wolfpack/protocol";
import { isKbVerb } from "./kb-life.ts";

export type KbLogVerb = "observe" | "consolidate" | "promote" | "processing" | "created" | "merged" | "rejected" | "parked";
export const FOLD_WINDOW_MS = 60_000;

/** What the map should highlight for a row: a wolf, a node (an event target), a flying topic, the curator. */
export interface KbLogFocus { wolf?: string; target?: { kind: string; id: string; domain?: string }; topicId?: string; curator?: boolean }

export interface KbLogRow {
	/** Stable id of the row (its first event). */
	key: string;
	verb: KbLogVerb;
	/** Domain group; null = the wolves' own steps (observe / consolidate). */
	domain: string | null;
	title: string;
	/** Latest event time (ms) and the first one. */
	at: number;
	firstAt: number;
	n: number;
	focus: KbLogFocus;
	/** Fold key: rows with the same one inside the window merge. */
	fold: string;
	wolf?: string;
	/** Details (hidden by default). */
	ids: string[];
	section?: string;
	outcome?: string;
	reason?: string;
	tokens?: number;
	ms?: number;
	count?: number;
	seed?: true;
}

export const LOG_VERB_LABEL: Record<KbLogVerb, string> = { observe: "Observed", consolidate: "Consolidated", promote: "Promoted", processing: "Processing", created: "Created", merged: "Merged", rejected: "Rejected", parked: "Parked" };

/** The log verb of an event (curate-done is split by its outcome), or null for events the log does not show. */
export function logVerbOf(e: Pick<ActivityEvent, "verb" | "detail">): KbLogVerb | null {
	switch (e.verb) {
		case "memory-observe": return "observe";
		case "memory-consolidate": return "consolidate";
		case "memory-promote": return "promote";
		case "curate-start": return "processing";
		case "curate-done": {
			const o = e.detail?.outcome;
			return o === "create" ? "created" : o === "reject" ? "rejected" : o === "parked" ? "parked" : "merged";
		}
		default: return null;
	}
}

/** Topic id -> domain, learnt from promote and curate-done events, so a "processing" row finds its domain group. */
export type TopicDomains = Map<string, string>;

/** One event as a (not yet folded) row; `undefined` for other verbs. `domains` is read and updated. */
export function rowOfEvent(e: ActivityEvent, at: number, domains: TopicDomains): KbLogRow | undefined {
	if (!isKbVerb(e.verb)) return undefined;
	const verb = logVerbOf(e)!;
	const d = e.detail ?? {};
	const topic = d.topicIds?.[0] ?? d.ref;
	const tdom = e.target?.domain ?? e.domain ?? (e.target?.kind === "domain" ? e.target.id : undefined);
	if (topic && tdom) domains.set(topic, tdom);
	const domain = verb === "observe" || verb === "consolidate" ? null : (tdom ?? (topic ? domains.get(topic) : undefined) ?? null);
	const wolf = e.actor.wolf;
	const base = { key: e.id, verb, domain, at, firstAt: at, n: 1, ids: [e.id, ...(d.topicIds ?? []), ...(d.ref ? [d.ref] : [])], ...(wolf ? { wolf } : {}), ...(d.section ? { section: d.section } : {}), ...(d.outcome ? { outcome: d.outcome } : {}), ...(d.reason ? { reason: d.reason } : {}), ...(d.tokens !== undefined ? { tokens: d.tokens } : {}), ...(d.ms !== undefined ? { ms: d.ms } : {}), ...(d.count !== undefined ? { count: d.count } : {}) };
	switch (verb) {
		case "observe":
			return { ...base, title: `${wolf ?? "wolf"} observed`, fold: `observe|${wolf}`, focus: { wolf } };
		case "consolidate":
			return { ...base, title: `${wolf ?? "wolf"} · ${d.count ?? "?"} notes → ${d.topicIds?.length ?? 1}`, fold: `consolidate|${wolf}`, focus: { wolf } };
		case "promote":
			return { ...base, title: `${topic ?? "topic"}`, fold: `promote|${topic}`, focus: { wolf, topicId: topic } };
		case "processing":
			return { ...base, title: `${topic ?? "topic"}`, fold: `processing|${topic}`, focus: { curator: true, topicId: topic } };
		default: {
			const title = e.target?.title ?? d.sectionTitle ?? topic ?? "entry";
			const target = e.target ? { kind: e.target.kind, id: e.target.id, ...(tdom ? { domain: tdom } : {}) } : undefined;
			return { ...base, title, fold: `${verb}|${e.target?.id ?? topic}`, focus: { ...(target ? { target } : { curator: true }), topicId: topic } };
		}
	}
}

/** Append one row to a list (newest first): fold into the newest row with the same fold key inside the window, else add. */
export function addRow(rows: readonly KbLogRow[], row: KbLogRow, windowMs = FOLD_WINDOW_MS): KbLogRow[] {
	const i = rows.findIndex((r) => r.fold === row.fold && Math.abs(row.at - r.at) <= windowMs && r.domain === row.domain);
	if (i < 0) return [row, ...rows].sort((a, b) => b.at - a.at);
	const r = rows[i]!;
	const merged: KbLogRow = { ...r, n: r.n + row.n, at: Math.max(r.at, row.at), firstAt: Math.min(r.firstAt, row.firstAt), ids: [...new Set([...r.ids, ...row.ids])].slice(0, 20), ...(row.tokens !== undefined ? { tokens: (r.tokens ?? 0) + row.tokens } : {}), ...(row.count !== undefined ? { count: (r.count ?? 0) + row.count } : {}) };
	return [merged, ...rows.slice(0, i), ...rows.slice(i + 1)].sort((a, b) => b.at - a.at);
}

/** Live rows (oldest first, as they arrived) folded into the log. */
export function foldEvents(events: readonly { event: ActivityEvent; at: number }[]): KbLogRow[] {
	const domains: TopicDomains = new Map();
	let rows: KbLogRow[] = [];
	for (const { event, at } of events) {
		const r = rowOfEvent(event, at, domains);
		if (r) rows = addRow(rows, r);
	}
	return rows;
}

/** Live rows over the ledger's history: a seed row the live feed already carries (same verb, same entry/topic title, within the window) is dropped. */
export function mergeSeed(live: readonly KbLogRow[], seed: readonly KbLogRow[], windowMs = FOLD_WINDOW_MS): KbLogRow[] {
	const kept = seed.filter((s) => !live.some((l) => l.verb === s.verb && l.domain === s.domain && l.title === s.title && Math.abs(l.at - s.at) <= windowMs));
	let rows = [...live];
	for (const s of kept) rows = addRow(rows, s, windowMs);
	return rows.sort((a, b) => b.at - a.at);
}

/** Groups in order of their newest row; `null` (the wolves) is shown as its own group. */
export function groupRows(rows: readonly KbLogRow[]): { domain: string | null; rows: KbLogRow[] }[] {
	const out: { domain: string | null; rows: KbLogRow[] }[] = [];
	for (const r of rows) {
		let g = out.find((x) => x.domain === r.domain);
		if (!g) out.push((g = { domain: r.domain, rows: [] }));
		g.rows.push(r);
	}
	return out;
}
