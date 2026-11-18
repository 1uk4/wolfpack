/**
 * REPLY NOTIFICATIONS (work-wolfpack-a51KXyW): a notification when a wolf finishes a turn with a message, so the owner
 * who is elsewhere (another thread, another window, the desktop app in the background) hears about it. PURE: no React, no IO.
 * All race and staleness decisions live here; the component only fetches and delivers.
 *
 *  1. `trackThreadStatus` folds `needs-you-changed` status events. busy starts a numbered turn of that thread; busy → idle
 *     ends it (`finished`, carrying the turn number) and the caller fetches the thread's recent page and calls `planReply`
 *     with that number. `syncBusy` primes/repairs the busy marks from the thread lists (load, resync).
 *  2. THE ANCHOR (nothing is fetched at turn start, so no fetch timing can lose a reply): the reply is the FINAL message
 *     of the fetched page. It is announced when it is an assistant message with text (not a compaction) that is new:
 *       - not announced before, and
 *       - not the message this tab last saw at the end of a page (`seen`, updated at every judgment), and
 *       - when `seen` is unknown, a user message exists earlier on the page (the turn's own prompt proves the page
 *         reaches back past the turn). With neither (a wolf-initiated turn on a thread not judged before, or a long
 *         turn whose prompt left the page) nothing is announced: an unplaceable page is never treated as fresh.
 *     Consequences: a fast reply, and a reply of a turn primed mid-stream, are announced at the end (nothing was
 *     captured at the start); a tool-only, aborted or errored turn ends on a message without text, or on one already
 *     seen: nothing; a tool-only FINAL message means nothing (a mid-turn preamble is not the reply). Known gap: when this tab has no
 *     `seen` for the thread (its first judgment, so after every reload), any judged turn that added no message but
 *     whose page holds a user message announces the old final reply once, if it was not announced before.
 *  3. If the final message is still the owner's the reply has not landed: `retry`. Every turn has a number; a judgment or
 *     drop for an older turn (a retry chain outlived by a new busy) is ignored, so a newer turn's reply is never dropped
 *     and a partial reply of the next turn is never announced as this one's.
 *  4. Cross-tab dedupe (`notifyOnce`): the tab that wins a Web Lock named after the reply's key (taken with ifAvailable and
 *     held for the page's life, so a tab judging later finds it taken) delivers; the others stay quiet. No Web Locks
 *     (or a failing one): deliver, as before. The lock is injected so a test can drive it.
 *  5. Not announced while the owner is looking at that thread (window focused AND visible AND on its page). Only
 *     owner-facing threads notify (not subagent or process threads, not closed history). Card prompts stay with
 *     needs-you.ts (planNotifications); a `needs-you` status does not end the turn.
 */

import { threadHref } from "./thread-adapter.ts";

export interface ReplyNotifyState {
	/** Threads whose turn is running. */
	busy: ReadonlySet<string>;
	/** Current turn number of each thread (bumped by every busy start). */
	turn: ReadonlyMap<string, number>;
	/** Threads whose turn just ended and whose reply is not yet judged, with that turn's number. */
	pending: ReadonlyMap<string, number>;
	/** Last message id at the end of the page this tab judged, per thread. */
	seen: ReadonlyMap<string, string>;
	/** Event counter, and its value at each thread's last event: lets a sync keep what events changed meanwhile. */
	seq: number;
	touched: ReadonlyMap<string, number>;
	/** Reply messages already announced (or deliberately skipped because the owner was looking). Bounded. */
	announced: ReadonlySet<string>;
}

export const INITIAL_REPLY_STATE: ReplyNotifyState = { busy: new Set(), turn: new Map(), pending: new Map(), seen: new Map(), seq: 0, touched: new Map(), announced: new Set() };

const ANNOUNCED_MAX = 200;
const threadKey = (wolf: string, threadId: string): string => `${wolf}\n${threadId}`;
const without = <V>(m: ReadonlyMap<string, V>, key: string): Map<string, V> => {
	const next = new Map(m);
	next.delete(key);
	return next;
};

/** Only threads the owner talks to notify: not subagent or process threads (the wolf's own work), not closed history. */
const ownerFacing = (t: { kind?: string; closed?: boolean }): boolean => t.kind !== "subagent" && t.kind !== "process" && t.closed !== true;

/** Start a turn of `key`: a new number, any unjudged reply of the previous turn voided. */
function startTurn(state: ReplyNotifyState, key: string): ReplyNotifyState {
	return { ...state, busy: new Set(state.busy).add(key), turn: new Map(state.turn).set(key, (state.turn.get(key) ?? 0) + 1), pending: without(state.pending, key) };
}

/** Fold one status event. `finished`: a busy thread went idle (`turn` is the number to judge with). */
export function trackThreadStatus(
	state: ReplyNotifyState,
	ev: { wolf: string; threadId: string; status: "idle" | "busy" | "needs-you" },
): { state: ReplyNotifyState; finished: boolean; turn?: number } {
	const key = threadKey(ev.wolf, ev.threadId);
	if (ev.status === "needs-you") return { state, finished: false };
	const stamped: ReplyNotifyState = { ...state, seq: state.seq + 1, touched: new Map(state.touched).set(key, state.seq + 1) };
	if (ev.status === "busy") return { state: stamped.busy.has(key) ? { ...stamped, pending: without(stamped.pending, key) } : startTurn(stamped, key), finished: false };
	if (!stamped.busy.has(key)) return { state: stamped, finished: false };
	const turn = stamped.turn.get(key) ?? 0;
	const busy = new Set(stamped.busy);
	busy.delete(key);
	return { state: { ...stamped, busy, pending: new Map(stamped.pending).set(key, turn) }, finished: true, turn };
}

/**
 * Apply the thread lists a snapshot (of `wolves`, fetched from the moment `state.seq` was `since`) reports. A thread
 * that is busy OR needs-you is mid-turn (a card prompt does not end the turn): it is marked, or its mark kept, so a
 * busy -> needs-you -> idle turn still notifies. Marks of those wolves that the snapshot shows idle (or not at all) are
 * stale (an idle event was lost across a reconnect): cleared, and the thread queued for one judgment (`pending`), so its
 * reply is not silently dropped. A thread an event touched after `since` keeps the event's verdict, because the snapshot
 * may predate it. Threads of other wolves are left alone.
 */
export function syncBusy(state: ReplyNotifyState, since: number, wolves: readonly string[], threads: readonly { wolf: string; threadId: string; status?: string }[]): ReplyNotifyState {
	const fresh = (key: string): boolean => (state.touched.get(key) ?? 0) > since;
	const listed = new Set(threads.filter((t) => t.status === "busy" || t.status === "needs-you").map((t) => threadKey(t.wolf, t.threadId)));
	const covered = new Set(wolves);
	const stale = [...state.busy].filter((key) => !listed.has(key) && !fresh(key) && covered.has(key.slice(0, key.indexOf("\n"))));
	let next: ReplyNotifyState = { ...state, busy: new Set([...state.busy].filter((key) => !stale.includes(key))) };
	if (stale.length) next = { ...next, pending: new Map([...next.pending, ...stale.map((key) => [key, next.turn.get(key) ?? 0] as const)]) };
	for (const key of listed) if (!next.busy.has(key) && !fresh(key)) next = startTurn(next, key);
	return next;
}

export interface ReplyNotification {
	key: string;
	title: string;
	body: string;
	href: string;
}

/** First non-empty line of the reply, trimmed and capped. */
export function replyBody(text: string, max = 140): string {
	const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const decode = (s: string): string => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};
/** A path decoded and without a trailing slash, so "/wolf/w/thread/a%20b/" equals "/wolf/w/thread/a b". */
const normPath = (p: string): string => decode(p).replace(/\/+$/, "");

/**
 * Judge the thread fetched after turn `turn` ended (see the anchor rule above). `retry`: the last message is the
 * owner's (the transcript lags): fetch again; the caller gives up with `dropReply`.
 */
export function planReply(
	state: ReplyNotifyState,
	thread: { wolf: string; id: string; title: string; kind?: string; closed?: boolean; messages: readonly { id: string; role: "user" | "assistant"; text: string; compaction?: unknown }[] },
	view: { focused: boolean; visible: boolean; pathname: string },
	turn: number,
): { notification?: ReplyNotification; state: ReplyNotifyState; retry?: boolean } {
	const tkey = threadKey(thread.wolf, thread.id);
	// No settled turn waiting, or a newer turn has begun since this judgment started: nothing to announce.
	if (state.pending.get(tkey) !== turn) return { state };
	const last = thread.messages[thread.messages.length - 1];
	if (last && last.role === "user") return { state, retry: true };
	const settled: ReplyNotifyState = { ...state, pending: without(state.pending, tkey), ...(last ? { seen: new Map(state.seen).set(tkey, last.id) } : {}) };
	if (!ownerFacing(thread) || !last || last.compaction || replyBody(last.text) === "") return { state: settled };
	const seen = state.seen.get(tkey);
	const placed = seen !== undefined || thread.messages.some((m) => m.role === "user");
	if (!placed || last.id === seen) return { state: settled };
	const key = `${tkey}\n${last.id}`;
	if (state.announced.has(key)) return { state: settled };
	const announced = new Set(state.announced).add(key);
	if (announced.size > ANNOUNCED_MAX) announced.delete(announced.values().next().value as string);
	const next = { ...settled, announced };
	const href = threadHref(thread.wolf, thread.id);
	if (view.focused && view.visible && normPath(view.pathname) === normPath(href)) return { state: next };
	return { notification: { key, title: `${thread.wolf} · ${thread.title}`, body: replyBody(last.text), href }, state: next };
}

/** Stop waiting for turn `turn`'s reply (the retries ran out). A newer turn's pending reply is left alone. */
export function dropReply(state: ReplyNotifyState, wolf: string, threadId: string, turn: number): ReplyNotifyState {
	const key = threadKey(wolf, threadId);
	return state.pending.get(key) === turn ? { ...state, pending: without(state.pending, key) } : state;
}

/** The part of Web Locks `notifyOnce` needs (navigator.locks satisfies it). */
export interface ReplyLocks {
	request(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<void>): Promise<unknown>;
}

/**
 * The claim lasts as long as the page: the winning tab keeps its lock with a promise that never settles, and the
 * browser releases it when the page unloads or the tab closes. Limits: a tab that judges the same reply after the
 * winner has closed can deliver it again; one lock is held per delivered reply for the page's life (a few bytes each).
 */
const holdForever = (): Promise<void> => new Promise<void>(() => {});

/** Deliver `n` only if this tab wins the claim on its key (one notification per reply across tabs). Resolves once decided. */
export async function notifyOnce(locks: ReplyLocks | undefined, n: ReplyNotification, deliver: () => void, hold: () => Promise<void> = holdForever): Promise<void> {
	if (!locks) return deliver();
	let decided = false;
	let decide: () => void = () => {};
	const settled = new Promise<void>((resolve) => (decide = resolve));
	try {
		const requested = locks.request(`wolfpack-reply:${n.key}`, { ifAvailable: true }, async (lock) => {
			decided = true;
			decide(); // resolve at the decision, not when the hold ends
			if (!lock) return;
			deliver();
			await hold();
		});
		requested.catch(() => {}); // a rejection after the decision is of no interest
		await Promise.race([settled, requested]);
	} catch {
		// request threw or rejected before deciding: deliver, as with no Web Locks
		if (!decided) deliver();
	}
}

/** Single-flight `run`: a call during a run queues exactly one follow-up run (it must not reuse the older run's snapshot). */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
	let current: Promise<void> | null = null;
	let again = false;
	return () => {
		if (current) {
			again = true;
			return current;
		}
		current = (async () => {
			try {
				do {
					again = false;
					await run();
				} while (again);
			} finally {
				current = null;
			}
		})();
		return current;
	};
}
