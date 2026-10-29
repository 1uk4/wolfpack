import type { ThreadEvent } from "@wolfpack/client";
import { withHistoryAttachments } from "@/components/attachments";
import { ThreadEventAdapter, threadMessagesToNative } from "@/src/core";
import type { SessionTransport } from "@/components/session-core";

/** Messages per transcript page: the initial open, each "Show earlier" and the settle refetch. */
export const THREAD_PAGE_SIZE = 50;

/**
 * The session transport for a ConsoleClient thread: the /api/wolves routes
 * (thin wrappers over the client), with ThreadEvents folded to the session
 * model's wire events by the pure ThreadEventAdapter. A 409 (busy) is
 * surfaced, never polled — idle submits are whenBusy=reject; a mid-turn
 * send is whenBusy=steer.
 */
export function threadBase(wolf: string, slug: string): string {
	return `/api/wolves/${encodeURIComponent(wolf)}/threads/${encodeURIComponent(slug)}`;
}

/** Where a pending card's answer is POSTed (the console's server layer, then the wolf's /v1). */
export function cardAnswerUrl(wolf: string, slug: string, callId: string): string {
	return `${threadBase(wolf, slug)}/cards/${encodeURIComponent(callId)}/answer`;
}

/** Where a pending card's skip is POSTed. */
export function cardSkipUrl(wolf: string, slug: string, callId: string): string {
	return `${threadBase(wolf, slug)}/cards/${encodeURIComponent(callId)}/skip`;
}

/** Where the composer controls GET / PUT the thread's settings (tier, auto-ship). */
export function settingsUrl(wolf: string, slug: string): string {
	return `${threadBase(wolf, slug)}/settings`;
}

/** Context stats (GET) and the manual compaction (POST {instructions?}). */
export function contextUrl(wolf: string, slug: string): string {
	return `${threadBase(wolf, slug)}/context`;
}
export function compactUrl(wolf: string, slug: string): string {
	return `${threadBase(wolf, slug)}/compact`;
}

// --- feature progress: bind ---
/** Where the bind icon POSTs `{workItemId}`. */
export function bindUrl(wolf: string, slug: string): string {
	return `${threadBase(wolf, slug)}/bind`;
}
// --- end feature progress ---

/**
 * `onCardEvent` hears the thread's live card events (card-pending / card-settled): the cards are not part of the
 * message stream, so the chat folds them itself (see foldCardEvent).
 */
/** The thread events that change a thread's cards (not part of the message stream). */
export type ThreadCardEvent = Extract<ThreadEvent, { type: "card-pending" | "card-settled" }>;

export function threadTransport(
	wolf: string,
	slug: string,
	onCardEvent?: (ev: ThreadCardEvent) => void,
	/** An older page landed (raw thread JSON): the caller folds its card calls. */
	onPage?: (json: unknown) => void,
): SessionTransport {
	const base = threadBase(wolf, slug);
	return {
		submitUrl: `${base}/submit`,
		submitBody: (input, opts) =>
			JSON.stringify({
				input: input.type === "text" ? input.text : "",
				whenBusy: opts?.whenBusy ?? "reject",
				...(input.type === "text" && input.attachments?.length ? { attachments: input.attachments.map((a) => ({ id: a.id })) } : {}),
			}),
		uploadUrl: `${base}/attachments`,
		attachmentUrl: (id) => `${base}/attachments/${encodeURIComponent(id)}`,
		steersViaSubmit: true,
		// The record is the newest page only: the full transcript is never refetched on a settle.
		recordUrl: `${base}?limit=${THREAD_PAGE_SIZE}`,
		onPage,
		pageUrl: (before, limit) => `${base}?limit=${limit}&before=${encodeURIComponent(before)}`,
		parseRecord: (json) => {
			const messages = (json as { messages?: Parameters<typeof threadMessagesToNative>[0] }).messages;
			return Array.isArray(messages) ? withHistoryAttachments(threadMessagesToNative(messages), messages) : null;
		},
		recordIdle: (json) => (json as { busy?: unknown }).busy === false,
		streamUrl: `${base}/stream`,
		abortUrl: `${base}/abort`,
		retryOnBusy: false,
		// Fresh adapter per consume: it carries the in-flight message.
		createWire: () => {
			const adapter = new ThreadEventAdapter();
			return (raw) => {
				const ev = raw as unknown as ThreadEvent;
				if (ev.type === "card-pending" || ev.type === "card-settled") onCardEvent?.(ev);
				return adapter.apply(ev);
			};
		},
	};
}
