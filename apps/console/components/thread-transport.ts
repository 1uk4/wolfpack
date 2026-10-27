import type { ThreadEvent } from "@wolfpack/client";
import { withHistoryAttachments } from "@/components/attachments";
import { ThreadEventAdapter, threadMessagesToNative } from "@/src/core";
import type { SessionTransport } from "@/components/session-core";

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
		recordUrl: base,
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
