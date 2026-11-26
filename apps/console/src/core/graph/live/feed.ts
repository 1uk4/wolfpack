/**
 * ACTIVITY FEED FORMATTER (pure, no DOM): turns the live event ring into short feed lines, e.g. "1uk4 · scout read Crawl Pipeline".
 * Noise is dropped (thread-active heartbeats, thread-idle) and a consecutive duplicate (same actor + verb + target) within 30 s is merged
 * into one line carrying the latest time. Also: relative time, a stable wolf colour and the collapsed "N new" counter reducer.
 */
export interface FeedEvent {
	id: string;
	/** Arrival time (ms). */
	at: number;
	ts: number;
	verb: string;
	actor: { kind?: string; wolf?: string; threadId?: string; parentThreadId?: string; subagent?: string; title?: string };
	target?: { kind: string; id: string; domain?: string; title?: string };
}

export interface FeedLine {
	key: string;
	wolf: string;
	color: string;
	text: string;
	/** Arrival ms of the latest merged event. */
	time: number;
	tone: "normal" | "amber";
	/** Best-effort graph node id (the overlay resolves the target against the live graph). */
	nodeId?: string;
	target?: { kind: string; id: string; domain?: string };
	thread?: { wolf: string; threadId: string };
}

export const MERGE_MS = 30_000;

const PHRASE: Record<string, string> = {
	"kb-read": "read",
	"kb-write": "wrote",
	contribution: "updated",
	shipped: "shipped",
	bound: "bound to",
	unbound: "unbound from",
	"needs-you": "needs you",
	answered: "answered",
	"owner-viewing": "viewing",
};

/** A short id: the last dash-separated part of `kb-<domain>-<id>` / `work-<domain>-<id>`. */
const shortId = (id: string) => id.split("-").pop() || id;

/** Stable colour per wolf name (same wolf, same colour, in every theme). */
export function wolfColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return `hsl(${h % 360} 62% 58%)`;
}

export function nodeIdOf(t: { kind: string; id: string } | undefined): string | undefined {
	if (!t) return undefined;
	if (t.kind === "kb-entry") return `ent:${t.id}`;
	if (t.kind === "kb-section") return `sec:${t.id}`;
	if (t.kind === "work-item") return `work:${/^work-[a-z0-9]+-(.+)$/i.exec(t.id)?.[1] ?? t.id}`;
	return undefined;
}

const sameKey = (e: FeedEvent) => `${e.actor.wolf ?? ""}|${e.actor.subagent ?? ""}|${e.verb}|${e.target?.kind ?? ""}:${e.target?.id ?? ""}`;

export function formatFeed(events: readonly FeedEvent[], opts: { private?: boolean }): FeedLine[] {
	const out: FeedLine[] = [];
	let lastKey = "";
	for (const e of events) {
		if (e.verb === "thread-idle" || e.verb === "thread-active") continue;
		const you = e.verb === "owner-viewing";
		const wolf = you ? "you" : e.actor.wolf;
		if (!wolf) continue;
		const k = sameKey(e);
		const prev = out[out.length - 1];
		if (prev && k === lastKey && e.at - prev.time <= MERGE_MS) {
			prev.time = e.at;
			continue;
		}
		const sa = e.actor.subagent;
		let phrase: string;
		let name = "";
		if (e.verb === "subagent-spawned") phrase = `started ${sa ?? "subagent"}`;
		else if (e.verb === "subagent-finished") phrase = `${sa ?? "subagent"} finished`;
		else {
			const p = PHRASE[e.verb];
			if (!p) continue;
			phrase = sa ? `${sa} ${p}` : p;
			if (!opts.private && e.target) name = e.target.title ?? shortId(e.target.id);
		}
		const threadId = e.actor.threadId ?? e.actor.parentThreadId;
		out.push({
			key: e.id,
			wolf,
			color: you ? "hsl(0 0% 62%)" : wolfColor(wolf),
			text: `${wolf} · ${phrase}${name ? ` ${name}` : ""}`,
			time: e.at,
			tone: e.verb === "needs-you" ? "amber" : "normal",
			nodeId: nodeIdOf(e.target),
			target: e.target ? { kind: e.target.kind, id: e.target.id, domain: e.target.domain } : undefined,
			thread: !you && e.actor.wolf && threadId ? { wolf: e.actor.wolf, threadId } : undefined,
		});
		lastKey = k;
	}
	return out;
}

/** "now", "12s", "3m", "1h". */
export function relativeTime(now: number, at: number): string {
	const s = Math.max(0, Math.floor((now - at) / 1000));
	if (s < 5) return "now";
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h`;
}

export interface FeedCount { collapsed: boolean; count: number }
export type FeedCountAction = { type: "collapse" } | { type: "expand" } | { type: "new"; n: number };

/** The "Activity · N new" chip: N counts events since collapsing, keeps rising, resets on expand. */
export function feedCountReducer(s: FeedCount, a: FeedCountAction): FeedCount {
	if (a.type === "collapse") return { collapsed: true, count: 0 };
	if (a.type === "expand") return { collapsed: false, count: 0 };
	return s.collapsed ? { collapsed: true, count: s.count + a.n } : s;
}
