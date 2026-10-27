/**
 * THE NEEDS-YOU LIST (ticket 4): the cards waiting for the operator across every wolf, the pinned sidebar section's
 * model, and the pure logic that decides when an OS notification fires. PURE: no React, no IO.
 *
 * Truth is the wolves' lists (GET cards + threads); the activity stream only pokes ("needs-you-changed") and the
 * console refetches (notify → fetch, src/core/events.ts).
 */

import type { Card, PendingCard } from "@wolfpack/client";
import { threadHref, threadSlug } from "./thread-adapter.ts";

/** One pending card with the routing facts the list needs (what the console server sends). */
export interface NeedsYouItem {
	wolf: string;
	/** The client's thread id. */
	threadId: string;
	threadTitle: string;
	/** URL slug of the thread: the answer route is /api/wolves/:wolf/threads/:slug/cards/:callId/answer. */
	slug: string;
	/** The page that opens the thread. */
	href: string;
	callId: string;
	card: Card;
	raisedAt: string;
	heldAnswer?: PendingCard["heldAnswer"];
}

/** What one wolf reports: its pending cards and its threads (for titles). */
export interface WolfNeedsYou {
	wolf: string;
	cards: readonly PendingCard[];
	threads: readonly { id: string; title: string }[];
}

/** Flatten per-wolf reports into the list: oldest first (the one waiting longest on top), stable on ties. */
export function buildNeedsYou(wolves: readonly WolfNeedsYou[]): NeedsYouItem[] {
	const items: NeedsYouItem[] = [];
	for (const w of wolves) {
		for (const p of w.cards) {
			const title = w.threads.find((t) => t.id === p.threadId)?.title ?? threadSlug(w.wolf, p.threadId);
			items.push({
				wolf: w.wolf,
				threadId: p.threadId,
				threadTitle: title,
				slug: threadSlug(w.wolf, p.threadId),
				href: threadHref(w.wolf, p.threadId),
				callId: p.callId,
				card: p.card,
				raisedAt: p.raisedAt,
				...(p.heldAnswer ? { heldAnswer: p.heldAnswer } : {}),
			});
		}
	}
	return items
		.map((item, i) => ({ item, i }))
		.sort((a, b) => Date.parse(a.item.raisedAt) - Date.parse(b.item.raisedAt) || a.i - b.i)
		.map((x) => x.item);
}

/** The card's one-line headline: its title, else the first question. */
export function cardHeadline(card: Card): string {
	return card.title ?? card.fields[0]?.label ?? "Question";
}

/** Stable key of an item across wolves (call ids are only unique per thread). */
export const itemKey = (i: Pick<NeedsYouItem, "wolf" | "threadId" | "callId">): string => `${i.wolf}\n${i.threadId}\n${i.callId}`;

/** Drop an answered card from the list (before the refetch confirms it). */
export function withoutItem(items: readonly NeedsYouItem[], key: string): NeedsYouItem[] {
	return items.filter((i) => itemKey(i) !== key);
}

// ------------------------------------------------------------ notifications

/** An OS notification to show: the wolf and thread in the title, the card question in the body. */
export interface NeedsYouNotification {
	/** Dedupe key: the first newly pending card of the thread. */
	key: string;
	title: string;
	body: string;
	/** Where clicking it goes. */
	href: string;
}

export interface NotifyState {
	/** Cards seen so far (notified or not): a card is announced at most once. */
	seen: ReadonlySet<string>;
	/** False until the first snapshot has been taken: cards already pending at startup are not "new". */
	primed: boolean;
}

export const INITIAL_NOTIFY_STATE: NotifyState = { seen: new Set(), primed: false };

/**
 * Decide the notifications for a new snapshot of the list. A thread TRANSITIONS into needs-you when a card of it appears
 * that has not been seen: one notification per such thread (its first new card), deduped per card across snapshots, so
 * a refetch, a reconnect or a held-answer update never fires again. Nothing fires for the very first snapshot, and
 * nothing while the window is focused (the operator is looking at it; those cards are still marked seen).
 */
export function planNotifications(
	state: NotifyState,
	items: readonly NeedsYouItem[],
	opts: { focused: boolean },
): { notifications: NeedsYouNotification[]; state: NotifyState } {
	const seen = new Set(state.seen);
	const byThread = new Map<string, NeedsYouItem>();
	for (const item of items) {
		const key = itemKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		const thread = `${item.wolf}\n${item.threadId}`;
		if (!byThread.has(thread)) byThread.set(thread, item);
	}
	// Forget cards that left the list so the set stays bounded (a card never comes back once settled).
	const live = new Set(items.map(itemKey));
	for (const k of seen) if (!live.has(k)) seen.delete(k);
	const notifications: NeedsYouNotification[] = [];
	if (state.primed && !opts.focused) {
		for (const item of byThread.values()) {
			notifications.push({
				key: itemKey(item),
				title: `${item.wolf} · ${item.threadTitle}`,
				body: item.card.fields[0]?.label ?? cardHeadline(item.card),
				href: item.href,
			});
		}
	}
	return { notifications, state: { seen, primed: true } };
}
