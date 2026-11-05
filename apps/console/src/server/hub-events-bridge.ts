/**
 * THE HUB EVENTS BRIDGE (per SSE connection): follows the hub's pack event stream with the connection's own device token and re-emits
 * the frames the KB activity page needs (the curator's sweep_*, kb.changed, resync) on the event bus as `hub-event`. Everything else on
 * the hub stream (work.changed, wolf.presence) is not forwarded. Same lifecycle and auth law as the activity bridge: a hub 401 ends it
 * for good (onAuthLost), other failures retry with backoff, `stop` ends it.
 */
import type { ConsoleClient } from "@wolfpack/client";
import { emit, type ServerEvents } from "../core/events.ts";
import { abortableSleep } from "./needs-you-api.ts";

export const FORWARDED_HUB_EVENTS: ReadonlySet<string> = new Set(["sweep_started", "sweep_item", "sweep_finished", "kb.changed", "resync"]);

export interface HubBridgeOptions {
	backoffMs?: readonly number[];
	onAuthLost?: () => void;
}

export function createHubEventsBridge(forward: (frame: ServerEvents["hub-event"]["frame"]) => void = (frame) => emit("hub-event", { frame }), opts: HubBridgeOptions = {}) {
	const backoff = opts.backoffMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];
	const ctl = new AbortController();
	let started = false;

	async function follow(client: ConsoleClient): Promise<void> {
		let attempt = 0;
		while (!ctl.signal.aborted) {
			try {
				for await (const ev of client.watchHubEvents!({ signal: ctl.signal })) {
					attempt = 0;
					if (FORWARDED_HUB_EVENTS.has(ev.type)) forward(ev as unknown as ServerEvents["hub-event"]["frame"]);
				}
			} catch (err) {
				const e = err as { hubAuth?: boolean; name?: string; code?: string } | undefined;
				if (e?.hubAuth === true) {
					if (!ctl.signal.aborted) {
						ctl.abort();
						opts.onAuthLost?.();
					}
					return;
				}
				// Not a hub client (nothing to follow): give up instead of retrying forever.
				if (e?.name === "ProtocolError" && (e.code === "invalid_request" || e.code === "not_found")) return;
			}
			if (ctl.signal.aborted) return;
			await abortableSleep(backoff[Math.min(attempt++, backoff.length - 1)]!, ctl.signal);
		}
	}

	return {
		/** Idempotent: the first call with a client that can watch the hub starts the follow loop. */
		ensure(client: ConsoleClient): void {
			if (started || ctl.signal.aborted || !client.watchHubEvents) return;
			started = true;
			void follow(client);
		},
		stop: () => ctl.abort(),
	};
}
