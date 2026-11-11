/**
 * THE HUB EVENTS BRIDGE (one per SSE connection): follows the hub's pack event stream with THAT connection's device token and hands the
 * frames the KB activity page needs (the curator's sweep_*, kb.changed, resync) to `forward`, which writes them straight to that one
 * connection (events-stream.ts). Nothing goes through the process-wide bus: a frame fetched with one device's token must never reach
 * another connection (different domain scope), and N tabs must not multiply frames. work.changed / wolf.presence are not forwarded.
 *
 * Lifecycle (same law as the activity bridge): a hub 401 (`hubAuth`) ends it for good (onAuthLost); `unauthorized`, `version_mismatch`,
 * `invalid_request` and `not_found` are terminal too (retrying cannot fix them); anything else restarts with backoff, and every restart
 * forwards a synthetic `resync` (frames in the gap may have been missed, so the page refetches). The backoff resets only after a stream
 * stayed up for `stableMs`. `stop` ends it.
 * After a terminal code the bridge logs once and stays down for the connection's life: the page then relies on its 60 s poll.
 */
import type { ConsoleClient, HubEvent } from "@wolfpack/client";
import { abortableSleep } from "./needs-you-api.ts";

export const FORWARDED_HUB_EVENTS: ReadonlySet<string> = new Set(["sweep_started", "sweep_progress", "sweep_item", "sweep_finished", "kb.changed", "resync"]);
const TERMINAL_CODES: ReadonlySet<string> = new Set(["unauthorized", "version_mismatch", "invalid_request", "not_found"]);

export interface HubBridgeOptions {
	backoffMs?: readonly number[];
	/** A stream that stayed up this long was healthy: the backoff starts over (default 30 s). */
	stableMs?: number;
	onAuthLost?: () => void;
	now?: () => number;
}

export function createHubEventsBridge(forward: (frame: HubEvent) => void, opts: HubBridgeOptions = {}) {
	const backoff = opts.backoffMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];
	const stableMs = opts.stableMs ?? 30_000;
	const now = opts.now ?? Date.now;
	const ctl = new AbortController();
	let started = false;

	async function follow(client: ConsoleClient): Promise<void> {
		let attempt = 0;
		let restarts = 0;
		while (!ctl.signal.aborted) {
			if (restarts++ > 0) forward({ type: "resync", id: 0, at: new Date(now()).toISOString() } as HubEvent);
			const startedAt = now();
			try {
				for await (const ev of client.watchHubEvents!({ signal: ctl.signal })) {
					if (ctl.signal.aborted) return;
					if (FORWARDED_HUB_EVENTS.has(ev.type)) forward(ev);
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
				if (e?.name === "ProtocolError" && e.code && TERMINAL_CODES.has(e.code)) {
					console.error(`[hub-events-bridge] stopped on terminal error ${e.code}; the KB activity page falls back to its 60 s poll`);
					return;
				}
			}
			if (ctl.signal.aborted) return;
			if (now() - startedAt >= stableMs) attempt = 0;
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
