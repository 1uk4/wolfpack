/**
 * KB LIFE LOG (pure): the KB activity page's rows. One row per pipeline step, duplicates folded (same verb + same target/topic/wolf
 * within FOLD_WINDOW_MS become one row with a count), grouped by domain. One row per ITEM too: a topic's promote, curate-start and
 * curate-done events (correlated by detail.topicIds[0]) are one row whose state moves sent -> processing -> created / merged / rejected /
 * parked. Rows come from live pack.activity events and from the hub's ledger history (seed rows); a seed row the live feed already
 * carries is dropped. Raw ids never are the main text; they stay in `ids` for the details.
 */
import type { ActivityEvent } from "@wolfpack/protocol";
import { isKbVerb } from "./kb-life.ts";

export type KbLogVerb = "observe" | "consolidate" | "promote" | "processing" | "created" | "merged" | "rejected" | "parked";
export const FOLD_WINDOW_MS = 60_000;
/** A topic's promote / start / done events join into one row when they fall this close together. */
export const ITEM_WINDOW_MS = 30 * 60_000;

/** What the map should highlight for a row: a wolf, a node (an event target), a flying topic, the curator. */
export interface KbLogFocus { wolf?: string; target?: { kind: string; id: string; domain?: string }; topicId?: string; curator?: boolean; sectionPath?: string[] }

export interface KbLogRow {
	/** Stable id of the row (its first event). */
	key: string;
	verb: KbLogVerb;
	/** Domain group; null = the wolves' own steps (observe / consolidate). */
	domain: string | null;
	title: string;
	/** True when `title` is a real entry title (from the event or the ledger), not a "<wolf> → <domain>" label or an id. */
	titled?: true;
	/** Latest event time (ms) and the first one. */
	at: number;
	firstAt: number;
	n: number;
	focus: KbLogFocus;
	/** Fold key: rows with the same one inside the window merge. */
	fold: string;
	wolf?: string;
	/** The den topic id of an item row (promote / processing / done). */
	topic?: string;
	/** The KB entry a created / merged row landed in. */
	entryId?: string;
	/** Details (hidden by default). */
	ids: string[];
	section?: string;
	sectionTitle?: string;
	outcome?: string;
	/** The curator's reason: not on the activity bus; joined from the hub's KB activity ledger by topic id (see withReasons). */
	reason?: string;
	tokens?: number;
	ms?: number;
	count?: number;
	seed?: true;
}

export const LOG_VERB_LABEL: Record<KbLogVerb, string> = { observe: "Observed", consolidate: "Consolidated", promote: "Sent", processing: "Processing", created: "Created", merged: "Merged", rejected: "Rejected", parked: "Parked" };

const RANK: Record<KbLogVerb, number> = { observe: 0, consolidate: 0, promote: 1, processing: 2, created: 3, merged: 3, rejected: 3, parked: 3 };

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
	const entryId = e.target?.kind === "kb-entry" ? e.target.id : undefined;
	const item = verb === "promote" || verb === "processing" || RANK[verb] === 3;
	const base = {
		key: e.id, verb, domain, at, firstAt: at, n: 1,
		ids: [e.id, ...(d.topicIds ?? []), ...(d.ref ? [d.ref] : [])],
		...(wolf ? { wolf } : {}), ...(item && topic ? { topic } : {}), ...(entryId ? { entryId } : {}),
		...(d.section ? { section: d.section } : {}), ...(d.sectionTitle ? { sectionTitle: d.sectionTitle } : {}), ...(d.outcome ? { outcome: d.outcome } : {}),
		...(d.tokens !== undefined ? { tokens: d.tokens } : {}), ...(d.ms !== undefined ? { ms: d.ms } : {}), ...(d.count !== undefined ? { count: d.count } : {}),
	};
	switch (verb) {
		case "observe":
			return { ...base, title: `${wolf ?? "wolf"} observed`, fold: `observe|${wolf}`, focus: { wolf } };
		case "consolidate":
			return { ...base, title: `${wolf ?? "wolf"} · ${d.count ?? "?"} notes → ${d.topicIds?.length ?? 1}`, fold: `consolidate|${wolf}`, focus: { wolf } };
		case "promote":
			return { ...base, title: `${wolf ?? "wolf"} → ${domain ?? "KB"}`, fold: `promote|${topic ?? e.id}`, focus: { wolf, topicId: topic } };
		case "processing":
			return { ...base, title: `curator → ${domain ?? "KB"}`, fold: `processing|${topic ?? e.id}`, focus: { curator: true, topicId: topic } };
		default: {
			const title = e.target?.title ?? entryId ?? `curator → ${domain ?? "KB"}`;
			const target = e.target ? { kind: e.target.kind, id: e.target.id, ...(tdom ? { domain: tdom } : {}) } : undefined;
			return { ...base, title, ...(e.target?.title ? { titled: true as const } : {}), fold: `${verb}|${entryId ?? topic ?? e.id}`, focus: { ...(target ? { target } : { curator: true }), topicId: topic, ...(Array.isArray(e.detail?.sectionPath) && e.detail.sectionPath.length ? { sectionPath: e.detail.sectionPath as string[] } : {}) } };
		}
	}
}

/** Two rows of one item: the further-along state leads; a real or id title beats the "<wolf> → <domain>" label; a repeat of the same state counts. */
function joinItem(r: KbLogRow, row: KbLogRow): KbLogRow {
	const lead = RANK[row.verb] >= RANK[r.verb] ? row : r;
	const other = lead === row ? r : row;
	const title = lead.titled || lead.entryId ? lead.title : r.wolf ? r.title : other.title;
	return {
		...other, ...lead,
		title, ...(lead.titled ? { titled: true as const } : {}),
		key: r.key, firstAt: Math.min(r.firstAt, row.firstAt), at: Math.max(r.at, row.at), n: r.verb === row.verb ? r.n + row.n : r.n,
		domain: lead.domain ?? other.domain,
		...(r.wolf ?? row.wolf ? { wolf: (r.wolf ?? row.wolf)! } : {}),
		focus: { ...other.focus, ...lead.focus, ...(r.focus.wolf ?? row.focus.wolf ? { wolf: (r.focus.wolf ?? row.focus.wolf)! } : {}) },
		ids: [...new Set([...r.ids, ...row.ids])].slice(0, 20),
	};
}

/** Append one row to a list (newest first): join the same item's row, else fold into the newest row with the same fold key inside the window, else add. */
export function addRow(rows: readonly KbLogRow[], row: KbLogRow, windowMs = FOLD_WINDOW_MS): KbLogRow[] {
	const sort = (xs: KbLogRow[]) => xs.sort((a, b) => b.at - a.at);
	const j = row.topic ? rows.findIndex((r) => r.topic === row.topic && Math.abs(row.at - r.at) <= ITEM_WINDOW_MS) : -1;
	if (j >= 0) return sort([joinItem(rows[j]!, row), ...rows.slice(0, j), ...rows.slice(j + 1)]);
	const i = rows.findIndex((r) => r.fold === row.fold && Math.abs(row.at - r.at) <= windowMs && r.domain === row.domain);
	if (i < 0) return sort([row, ...rows]);
	const r = rows[i]!;
	const merged: KbLogRow = { ...r, n: r.n + row.n, at: Math.max(r.at, row.at), firstAt: Math.min(r.firstAt, row.firstAt), ids: [...new Set([...r.ids, ...row.ids])].slice(0, 20), ...(row.tokens !== undefined ? { tokens: (r.tokens ?? 0) + row.tokens } : {}), ...(row.count !== undefined ? { count: (r.count ?? 0) + row.count } : {}) };
	return sort([merged, ...rows.slice(0, i), ...rows.slice(i + 1)]);
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

/** Entry id -> title, from the ledger's history rows. */
export function entryTitles(seed: readonly KbLogRow[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const s of seed) if (s.entryId && s.titled) m.set(s.entryId, s.title);
	return m;
}

/** A created / merged live row that has only an entry id for a title takes the ledger's entry title when known. */
export function withTitles(rows: readonly KbLogRow[], titles: ReadonlyMap<string, string>): KbLogRow[] {
	return rows.map((r) => {
		const t = !r.titled && r.entryId ? titles.get(r.entryId) : undefined;
		return t ? { ...r, title: t, titled: true as const } : r;
	});
}

/** Rows get the curator's reason from the ledger (topic id -> reason), the one place it is known; the activity bus does not carry it. */
export function withReasons(rows: readonly KbLogRow[], reasons: Readonly<Record<string, string>>): KbLogRow[] {
	return rows.map((r) => {
		if (r.reason) return r;
		const reason = r.topic ? reasons[r.topic] : r.ids.map((id) => reasons[id]).find(Boolean);
		return reason ? { ...r, reason } : r;
	});
}

/** Live rows over the ledger's history: a seed row the live feed already carries (same verb, same entry or title, within the window) is dropped. */
export function mergeSeed(live: readonly KbLogRow[], seed: readonly KbLogRow[], windowMs = FOLD_WINDOW_MS): KbLogRow[] {
	const kept = seed.filter((s) => !live.some((l) => l.verb === s.verb && l.domain === s.domain && (l.title === s.title || (l.entryId !== undefined && l.entryId === s.entryId)) && Math.abs(l.at - s.at) <= windowMs));
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
