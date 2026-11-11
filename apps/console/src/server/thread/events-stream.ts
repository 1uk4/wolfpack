/**
 * THE NOTIFICATION CHANNEL (push-architecture slice 1): GET /api/events is
 * an SSE response over the core event bus — one connection per open
 * window, held open until the view goes away, fed by every emitter
 * (turn lifecycle, job/chat stores, extraction registry).
 *
 * NOTIFY → FETCH (the architecture's whole trick): frames carry only the
 * event type + a tiny payload; consumers respond by fetching truth
 * (/api/chats/:id, /api/jobs, /api/activity). No payload versioning, no
 * replay protocol — a reconnect resyncs with one ordinary fetch per
 * consumer. This is a DESKTOP app talking to localhost: holding N≈1-3
 * connections costs one socket pair each and zero traffic while idle
 * (owner ruling 2026-10-02 — polling's cloud economics don't exist at
 * loopback; the poll lattice it left behind is what this replaces).
 *
 * Wire dialect mirrors the turn stream (pi/ui-stream.ts): text/event-stream,
 * no-cache/no-transform, X-Accel-Buffering off — plus a `: ping` comment
 * every 25s to keep any intermediary from idling the socket out (locally
 * unnecessary, harmless, and it makes dead-connection detection cheap).
 *
 * The DIFFERENCE from the turn stream is lifetime: a turn's stream ends at
 * settle ([DONE]); this channel ends when the CLIENT goes away — cancel()
 * is the only end, and it must leave the bus untouched for other windows.
 * The closure shape (teardown assigned in start, called in cancel) is the
 * ui-stream subscribe() pattern.
 */
import { subscribe, type ServerEvent } from "../../core/thread/events.ts";
import type { ConsoleClient } from "@wolfpack/client";
import { createConsoleClient, getConsoleClient, nextRequestToken } from "./console-client.ts";
import { HUB_AUTH_HEADER } from "../../core/hub-auth.ts";
import { createActivityBridge } from "./needs-you-api.ts";
import { createHubEventsBridge } from "./hub-events-bridge.ts";

/**
 * PER-CONNECTION BRIDGE (owner decision): every SSE connection runs its OWN activity bridge on THAT connection's device token; there is
 * no shared super-token and no process-wide loop. The token is read once, at connect (the request scope is gone by the time the bridge
 * loops run). Revoking a device ends its bridge (a hub 401 is terminal: the connection closes) and touches nobody else's; closing the
 * tab (cancel) stops the bridge with it.
 *
 * No token on the connection (unpaired, or a non-request caller such as a test) falls back to the process client, whose per-request
 * resolver answers 401 for it: the bridge then ends at once. The env token never stands in.
 */
async function connectionClient(): Promise<ConsoleClient> {
	let token: string | null | undefined;
	try {
		token = await nextRequestToken();
	} catch {
		token = null;
	}
	return token ? createConsoleClient(process.env, async () => token) : getConsoleClient();
}

export interface EventsOptions {
	/** The client this connection's bridge follows wolves with (default: pinned to the connection's own device token). */
	clientFor?: () => Promise<ConsoleClient>;
	/** Bridge tuning (tests). */
	bridge?: Parameters<typeof createActivityBridge>[1];
	/** Hub-events bridge tuning (tests). */
	hubBridge?: Parameters<typeof createHubEventsBridge>[1];
}

/** One window's subscription as an SSE Response. */
export function eventsResponse(eo: EventsOptions = {}): Response {
	const encoder = new TextEncoder();
	let teardown: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			let unsubscribe: (() => void) | undefined;
			let bridge: ReturnType<typeof createActivityBridge> | undefined;
			let hubBridge: ReturnType<typeof createHubEventsBridge> | undefined;
			let client: ConsoleClient | undefined;

			const stop = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (heartbeat) clearInterval(heartbeat);
				bridge?.stop(); // no leaked loops: this connection's wolf streams end with it
				hubBridge?.stop();
			};
			/** This connection's token was rejected: end the connection (the browser signs itself out on its next /api 401). */
			const authLost = () => {
				// A TERMINAL frame first: EventSource reconnects after a clean close, so without it a revoked tab would come back every ~3s
				// forever. The client closes its EventSource on `auth-lost` and goes to /pair.
				frame("event: auth-lost\ndata: {}\n\n");
				stop();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			const ensureBridge = () => {
				if (closed || !client) return;
				try {
					bridge?.ensure(client);
					hubBridge?.ensure(client);
				} catch {
					/* the channel works without it; the next ping retries */
				}
			};
			// Enqueue is the ONLY place the socket can reject us (the reader
			// died) — any failure routes through stop() so the listener and
			// the heartbeat never outlive the connection.
			const frame = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					stop();
				}
			};

			// Attach FIRST, synchronously: no event can fall between
			// construction and subscription (single-threaded — the same
			// attach-then-replay law as ui-stream's subscribe()).
			unsubscribe = subscribe((event: ServerEvent) => {
				const { type, ...payload } = event;
				frame(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
			});
			// Flush the headers now so EventSource.onopen fires immediately,
			// not at the first ping 25s later.
			frame(": connected\n\n");
			bridge = createActivityBridge(undefined, { ...eo.bridge, onAuthLost: authLost });
			hubBridge = createHubEventsBridge(
				// Straight to THIS connection (never the process-wide bus: another device's token may have a narrower scope).
				(ev) => frame(`event: hub-event\ndata: ${JSON.stringify({ frame: ev })}\n\n`),
				{ ...eo.hubBridge, onAuthLost: authLost },
			);
			void (eo.clientFor ?? connectionClient)().then(
				(c) => {
					client = c;
					ensureBridge();
				},
				() => {},
			);
			heartbeat = setInterval(() => {
				frame(": ping\n\n");
				ensureBridge();
			}, 25_000);

			teardown = stop;
		},
		cancel() {
			// The view went away: drop the listener + timer. The bus keeps
			// serving every other window untouched.
			teardown?.();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * The framework route's entry: no device token on the connect request = 401 right away (+ the hub-auth marker). A non-200 response is
 * terminal for EventSource (it does not reconnect), and the console's fetch wrapper sends the browser to /pair on its next /api call.
 * With a token, the connection's bridge is pinned to it; a token the hub later rejects ends in the `auth-lost` frame (see eventsResponse).
 */
export async function eventsRoute(env: Record<string, string | undefined> = process.env): Promise<Response> {
	// No hub configured (mock / direct-wolf dev): there is no pairing, so nothing to be unauthorized against.
	if (!env.WOLFPACK_HUB_URL?.trim()) return eventsResponse();
	let token: string | null | undefined;
	try {
		token = await nextRequestToken();
	} catch {
		token = null;
	}
	if (!token) return Response.json({ error: "this browser is not paired with the hub (no bearer token)", code: "unauthorized" }, { status: 401, headers: { [HUB_AUTH_HEADER]: "required" } });
	return eventsResponse({ clientFor: async () => createConsoleClient(env, async () => token) });
}
