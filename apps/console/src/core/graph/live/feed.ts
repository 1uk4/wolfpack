/**
 * ACTIVITY FEED FORMATTER (pure, no DOM): turns the live event ring into short feed lines, e.g. "1uk4 · scout read Crawl Pipeline".
 * A thread starting (thread-active while it was not active) and going idle are lines; heartbeats of an active thread are dropped. A consecutive duplicate (same actor + verb + target) within 30 s is merged
 * into one line carrying the latest time. Also: relative time, a stable wolf colour and the collapsed "N new" counter reducer.
 */
import type { ActivityEvent, PresenceSnapshot } from "@wolfpack/protocol";
import { threadKey } from "./thread-key.ts";
import { featureOfThread } from "./live-state.ts";

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
	"work-touch": "worked on",
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

const sameKey = (e: FeedEvent) => `${e.actor.wolf ?? ""}|${e.actor.subagent ?? ""}|${e.verb}|${e.verb.startsWith("thread-") ? (e.actor.threadId ?? "") : ""}|${e.target?.kind ?? ""}:${e.target?.id ?? ""}`;

export function formatFeed(events: readonly FeedEvent[], opts: { private?: boolean }): FeedLine[] {
	const out: FeedLine[] = [];
	let lastKey = "";
	const activeThreads = new Set<string>();
	for (const e of events) {
		if (e.verb === "thread-idle" || e.verb === "thread-active") {
			const tk = threadKey(e.actor.wolf ?? "", e.actor.threadId ?? "");
			const was = activeThreads.has(tk);
			if (e.verb === "thread-active") activeThreads.add(tk);
			else activeThreads.delete(tk);
			if (was === (e.verb === "thread-active") || !e.actor.wolf) continue; // a heartbeat, or an idle for a thread never seen active
		}
		const you = e.verb === "owner-viewing";
		const hub = e.actor.kind === "hub";
		const wolf = you ? "you" : hub ? e.actor.title || "hub" : e.actor.wolf;
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
		if (e.verb === "thread-active") {
			phrase = "started working";
			if (!opts.private && e.actor.title) name = e.actor.title;
		} else if (e.verb === "thread-idle") phrase = "idle";
		else if (e.verb === "subagent-spawned") phrase = `started ${sa ?? "subagent"}`;
		else if (e.verb === "subagent-finished") phrase = `${sa ?? "subagent"} finished`;
		else {
			const p = hub && e.verb === "kb-write" ? "updated" : PHRASE[e.verb];
			if (!p) continue;
			// A feature thread is named by its title (hidden in private view); a subagent by its name.
			const feat = !sa && e.actor.title && featureOfThread(e.actor.threadId ?? "") ? (opts.private ? "feature" : e.actor.title) : undefined;
			phrase = sa ? `${sa} ${p}` : feat ? `${feat} ${p}` : p;
			if (!opts.private && e.target) name = e.target.title ?? shortId(e.target.id);
		}
		const threadId = e.actor.threadId ?? e.actor.parentThreadId;
		out.push({
			key: e.id,
			wolf,
			color: you || hub ? "hsl(0 0% 62%)" : wolfColor(wolf),
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

/**
 * Feed events for the presence snapshot (active threads and running subagents), oldest first, newest last, at most `max`.
 * Arrival times are back-dated by the event's age on the hub clock.
 */
export function seedFeedFromSnapshot(snap: PresenceSnapshot, now: number, max = 50): (FeedEvent & Pick<ActivityEvent, "actor" | "target">)[] {
	const out: (FeedEvent & Pick<ActivityEvent, "actor" | "target">)[] = [];
	for (const entry of [...snap.threads, ...snap.subagents]) {
		const e = entry.event;
		if (e.verb !== "thread-active" && e.verb !== "subagent-spawned") continue;
		out.push({ id: e.id, at: Math.min(now, now - (snap.at - e.ts)), ts: e.ts, verb: e.verb, actor: e.actor, target: e.target });
	}
	return out.sort((a, b) => a.at - b.at).slice(-max);
}

/**
 * The expanded activity panel's CSS `bottom`. Desktop: 12px above the floating chat bar (`--chat-bar-top`). Phone: the collapsed chat icon sits at the
 * bottom centre (48px + 8px margin above the safe area), so the panel also ends at least 8px above its top (56 + 8 = 64px + the inset).
 */
export function feedPanelBottom(phone: boolean): string {
	const bar = "var(--chat-bar-top,0px) + 12px";
	return phone ? `max(${bar}, env(safe-area-inset-bottom) + 64px)` : `calc(${bar})`;
}

/** The collapsed pill: "Quiet" with nothing to show, "Activity" otherwise, with how many arrived since collapsing. */
export function feedPillLabel(newCount: number, lineCount: number): string {
	if (newCount > 0) return `Activity · ${newCount} new`;
	return lineCount === 0 ? "Quiet" : "Activity";
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
