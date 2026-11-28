/**
 * MEMORY TAB (pure, no DOM): what the graph Activity panel's Memory tab shows (work-wolfpack-UcDeqxX).
 *   memoryRows(events)   the pipeline steps as timed rows: "saved 5 notes", "3 topics to the curator", "Filed into Wolfpack › Console", "Merged into X", "Rejected";
 *   poolBars(events)     each wolf's latest pool (tokens against the consolidation threshold) from its memory-observe events;
 *   pendingNotice(p)     the stuck-saves warning line from the wolf's memory status;
 *   tabsFor / resolveTab / tabItems   the All / KB / Memory tabs; the graph's Memory switch (`live.memory`) removes the tab and the rows.
 */
import type { ActivityEvent } from "@wolfpack/protocol";
import type { FeedLine } from "./feed.ts";

export interface MemoryRow {
	key: string;
	/** Arrival time (ms) of the latest event folded into the row. */
	at: number;
	text: string;
	wolf?: string;
	/** What the map rings on hover: the wolf, the entry a curator result landed in, and the topic's dot (same shape as the KB log's focus). */
	focus: { wolf?: string; target?: { kind: string; id: string; domain?: string }; topicId?: string; sectionPath?: string[] };
}

/** Promotes of one wolf this close together read as one row ("3 topics to the curator"). */
export const PROMOTE_FOLD_MS = 60_000;

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Memory pipeline events (oldest first, with arrival ms) as rows, newest first. Observes are the pool bar, not rows. */
export function memoryRows(events: readonly { event: ActivityEvent; at: number }[]): MemoryRow[] {
	const rows: (MemoryRow & { promotes?: number })[] = [];
	const topicWolf = new Map<string, string>();
	for (const { event: e, at } of events) {
		const d = e.detail ?? {};
		const wolf = e.actor.wolf;
		if (e.verb === "memory-consolidate") {
			if (wolf) for (const t of d.topicIds ?? []) topicWolf.set(t, wolf);
			rows.push({ key: e.id, at, text: `${wolf ?? "wolf"} saved ${plural(d.count ?? 0, "note", "notes")}`, ...(wolf ? { wolf } : {}), focus: wolf ? { wolf } : {} });
		} else if (e.verb === "memory-promote") {
			if (wolf) for (const t of d.topicIds ?? []) topicWolf.set(t, wolf);
			const prev = rows.find((r) => r.promotes !== undefined && r.wolf === wolf && Math.abs(at - r.at) <= PROMOTE_FOLD_MS);
			if (prev) {
				prev.promotes! += 1;
				prev.at = Math.max(prev.at, at);
				prev.text = `${plural(prev.promotes!, "topic", "topics")} to the curator`;
			} else rows.push({ key: e.id, at, promotes: 1, text: "1 topic to the curator", ...(wolf ? { wolf } : {}), focus: { ...(wolf ? { wolf } : {}), ...(d.topicIds?.[0] ? { topicId: d.topicIds[0] } : {}) } });
		} else if (e.verb === "curate-done") {
			const topic = d.topicIds?.[0] ?? d.ref;
			const w = wolf ?? (topic ? topicWolf.get(topic) : undefined);
			const domain = e.target?.domain ?? e.domain;
			const o = d.outcome;
			const text = o === "create" ? `Filed into ${cap(domain ?? "the KB")}${d.sectionTitle ? ` › ${d.sectionTitle}` : ""}`
				: o === "reject" ? "Rejected"
				: o === "parked" ? "Parked"
				: e.target?.title ? `Merged into ${e.target.title}` : "Merged";
			const target = e.target ? { kind: e.target.kind, id: e.target.id, ...(domain ? { domain } : {}) } : undefined;
			rows.push({ key: e.id, at, text, ...(w ? { wolf: w } : {}), focus: { ...(w ? { wolf: w } : {}), ...(target ? { target } : {}), ...(topic ? { topicId: topic } : {}), ...(d.sectionPath?.length ? { sectionPath: d.sectionPath } : {}) } });
		}
	}
	return rows.map(({ promotes: _p, ...r }) => r).sort((a, b) => b.at - a.at);
}

export interface PoolBar { count: number; capacity: number }

/** The latest memory-observe per wolf: pool tokens (`count`) against the consolidation threshold (`capacity`). */
export function poolBars(events: readonly { event: ActivityEvent; at: number }[]): Record<string, PoolBar> {
	const out: Record<string, PoolBar> = {};
	for (const { event: e } of events) {
		const wolf = e.actor.wolf;
		const d = e.detail;
		if (e.verb !== "memory-observe" || !wolf || typeof d?.count !== "number" || typeof d.capacity !== "number") continue;
		out[wolf] = { count: d.count, capacity: d.capacity };
	}
	return out;
}

const tokens = (n: number) => (n >= 1000 ? `${(Math.round(n / 100) / 10).toString().replace(/\.0$/, "")}k` : `${Math.round(n)}`);

/** "8.6k of 40k"; "–" until the wolf's first observe. */
export function formatPool(p: PoolBar | undefined): string {
	return p ? `${tokens(p.count)} of ${tokens(p.capacity)}` : "–";
}

const duration = (ms: number) => {
	const m = Math.max(1, Math.floor(ms / 60_000));
	return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

/** The warning for stuck saves ("Saves stuck for 2h · retry in 40m") with the failure message as hover text; null when none. */
/** After this many failed tries the banner names the error rather than the countdown. */
const SHOW_ERROR_AFTER_TRIES = 3;
export function pendingNotice(p: { stuck: number; oldestAgeMs: number; nextRetryInMs: number; tries?: number; message?: string } | undefined): { text: string; title: string } | null {
	if (!p || p.stuck <= 0) return null;
	if (p.message && (p.tries ?? 0) >= SHOW_ERROR_AFTER_TRIES) return { text: `Saves stuck for ${duration(p.oldestAgeMs)} · ${p.message.length > 80 ? `${p.message.slice(0, 79)}…` : p.message}`, title: p.message };
	return { text: `Saves stuck for ${duration(p.oldestAgeMs)} · retry ${p.nextRetryInMs <= 0 ? "due" : `in ${duration(p.nextRetryInMs)}`}`, title: p.message ?? "" };
}

export type ActivityTab = "all" | "kb" | "memory";

/** The tabs on offer: the Memory tab only while the graph's Memory switch is on. */
export const tabsFor = (memoryOn: boolean): ActivityTab[] => (memoryOn ? ["all", "kb", "memory"] : ["all", "kb"]);

/** The saved tab (anything unknown, or Memory with the switch off, falls back to All). */
export function resolveTab(saved: string | null, memoryOn: boolean): ActivityTab {
	return saved === "kb" || (saved === "memory" && memoryOn) ? saved : "all";
}

export type TabItem = { kind: "line"; key: string; time: number; line: FeedLine } | { kind: "memory"; key: string; time: number; row: MemoryRow };

/** What the list shows, oldest first: All = feed lines and memory rows by time, KB = lines, Memory = rows; with the switch off, lines only. */
export function tabItems(tab: ActivityTab, lines: readonly FeedLine[], rows: readonly MemoryRow[], memoryOn: boolean): TabItem[] {
	const l: TabItem[] = lines.map((line) => ({ kind: "line", key: line.key, time: line.time, line }));
	const m: TabItem[] = rows.map((row) => ({ kind: "memory", key: row.key, time: row.at, row }));
	// KB = what was read, written or filed in the KB: lines whose target is a KB entry or section (thread starts, work touches and the rest are All only).
	if (tab === "kb") return l.filter((i) => i.kind === "line" && i.line.target?.kind.startsWith("kb-"));
	if (!memoryOn) return l;
	if (tab === "memory") return [...m].sort((a, b) => a.time - b.time);
	return [...l, ...m].sort((a, b) => a.time - b.time);
}

/** The curator line's numbers: `pending` entries waiting at Home (the hub queue), `filing` = curate-start seen without its curate-done. */
export function curatorCounts(pending: number, events: readonly { event: ActivityEvent; at: number }[]): { pending: number; filing: number } {
	const open = new Set<string>();
	for (const { event: e } of events) {
		const id = e.detail?.topicIds?.[0] ?? e.detail?.ref;
		if (!id) continue;
		if (e.verb === "curate-start") open.add(id);
		else if (e.verb === "curate-done") open.delete(id);
	}
	return { pending, filing: open.size };
}

/** "Curator · 3 pending · 1 filing"; null when both are 0 (nothing extra to show). */
export function curatorText(c: { pending: number; filing: number }): string | null {
	const parts = [c.pending > 0 ? `${c.pending} pending` : "", c.filing > 0 ? `${c.filing} filing` : ""].filter(Boolean);
	return parts.length ? ["Curator", ...parts].join(" · ") : null;
}
