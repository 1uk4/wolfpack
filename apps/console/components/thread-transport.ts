import type { ThreadEvent } from "@wolfpack/client";
import { ThreadEventAdapter, threadMessagesToNative } from "@/src/core";
import type { SessionTransport } from "@/components/session-core";

/**
 * The session transport for a ConsoleClient thread: the /api/wolves routes
 * (thin wrappers over the client), with ThreadEvents folded to the session
 * model's wire events by the pure ThreadEventAdapter. A 409 (busy) is
 * surfaced, never polled — idle submits are whenBusy=reject; a mid-turn
 * send is whenBusy=steer.
 */
export function threadTransport(wolf: string, slug: string): SessionTransport {
	const base = `/api/wolves/${encodeURIComponent(wolf)}/threads/${encodeURIComponent(slug)}`;
	return {
		submitUrl: `${base}/submit`,
		submitBody: (input, opts) =>
			JSON.stringify({
				input: input.type === "text" ? input.text : "",
				whenBusy: opts?.whenBusy ?? "reject",
				...(input.type === "text" && input.attachments?.length ? { attachments: input.attachments } : {}),
			}),
		uploadUrl: `${base}/attachments`,
		steersViaSubmit: true,
		recordUrl: base,
		parseRecord: (json) => {
			const messages = (json as { messages?: Parameters<typeof threadMessagesToNative>[0] }).messages;
			return Array.isArray(messages) ? threadMessagesToNative(messages) : null;
		},
		streamUrl: `${base}/stream`,
		abortUrl: `${base}/abort`,
		retryOnBusy: false,
		// Fresh adapter per consume: it carries the in-flight message.
		createWire: () => {
			const adapter = new ThreadEventAdapter();
			return (raw) => adapter.apply(raw as unknown as ThreadEvent);
		},
	};
}
