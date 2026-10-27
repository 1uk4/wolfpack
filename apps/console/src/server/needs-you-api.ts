/**
 * THE NEEDS-YOU API: the cards waiting for the operator across every wolf (GET /api/needs-you), and the bridge that
 * turns each wolf's activity stream into "needs-you-changed" pokes on the event bus.
 *
 * Notify → fetch: the stream never feeds the list directly; every thread-status / card event (and a resync) just emits
 * `needs-you-changed {wolf}`, windows refetch this route. A wolf that is unreachable is skipped (its cards are simply
 * not listed until it answers again); the list never fails because one wolf is down.
 *
 * Answering is NOT here: it goes through the same thread route as an inline card (thread-api answerCard).
 */

import type { ConsoleClient, WolfEvent } from "@wolfpack/client";
import { buildNeedsYou, type WolfNeedsYou } from "../core/needs-you.ts";
import { emit, type ServerEvents } from "../core/events.ts";
import { getConsoleClient } from "./console-client.ts";
import type { ClientSource } from "./thread-api.ts";

/**
 * Pending cards and thread titles of every wolf (or just `only`). `responded` names the wolves that answered: an
 * unreachable wolf is absent from both, and the caller must not conclude its cards are gone.
 */
export async function collectNeedsYou(client: ConsoleClient, only?: string): Promise<{ reports: WolfNeedsYou[]; responded: string[]; listed: string[] }> {
	if (!client.listCards) return { reports: [], responded: [], listed: [] };
	const names = only ? [only] : (await client.listWolves()).map((w) => w.name);
	const reports = await Promise.all(
		names.map(async (wolf): Promise<WolfNeedsYou | null> => {
			try {
				const [cards, threads] = await Promise.all([client.listCards!(wolf), client.listThreads(wolf)]);
				return { wolf, cards, threads };
			} catch {
				return null;
			}
		}),
	);
	const ok = reports.filter((r): r is WolfNeedsYou => r !== null);
	return { reports: ok, responded: ok.map((r) => r.wolf), listed: names };
}

export function createNeedsYouApi(source: ClientSource, opts: { onList?: (client: ConsoleClient) => void } = {}) {
	return {
		/** `wolf`: only that wolf (the poked-wolf refetch). Answers `{items, responded}`. */
		async list(wolf?: string): Promise<Response> {
			try {
				const client = source();
				opts.onList?.(client);
				const { reports, responded, listed } = await collectNeedsYou(client, wolf);
				return Response.json({ items: buildNeedsYou(reports), responded, ...(wolf ? {} : { wolves: listed }) });
			} catch (err) {
				return Response.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: 500 });
			}
		},
	};
}

export interface BridgeOptions {
	/** Retry delays for a dropped wolf stream, last one repeats. */
	backoffMs?: readonly number[];
	/** How long the wolf list is cached before `ensure` re-reads it. */
	wolvesTtlMs?: number;
	/** No bytes (frames or keepalives) for this long = half-open; the client reconnects. */
	idleMs?: number;
}

/** What a wolf event says about who changed (resync: nothing, so consumers refetch everything). */
function changeOf(ev: WolfEvent): Omit<ServerEvents["needs-you-changed"], "wolf"> {
	switch (ev.type) {
		case "thread-status":
			return { threadId: ev.threadId, kind: "status", status: ev.status };
		case "card-pending":
			return { threadId: ev.card.threadId, kind: "card" };
		case "card-settled":
			return { threadId: ev.threadId, kind: "card" };
		default:
			return {};
	}
}

/** Sleep that ends early on abort; the abort listener is removed when the timer fires (no growth over many retries). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(t);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const t = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/**
 * Follow every wolf's activity stream and poke the bus on each change. `ensure` is cheap and idempotent (the wolf list is
 * cached; a followed wolf is not followed twice). A stream that ends or gives up is retried with backoff, and every
 * (re)start pokes once: events in the gap may have been missed (or resynced), so consumers refetch.
 */
export function createActivityBridge(poke: (wolf: string, change?: Omit<ServerEvents["needs-you-changed"], "wolf">) => void = (wolf, change) => emit("needs-you-changed", { wolf, ...change }), opts: BridgeOptions = {}) {
	const backoff = opts.backoffMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];
	const ttl = opts.wolvesTtlMs ?? 30_000;
	const following = new Set<string>();
	const ctl = new AbortController();
	let wolves: string[] = [];
	let wolvesAt = 0;
	let wolvesPending: Promise<void> | undefined;

	/** Per-wolf stop switches: a wolf that leaves the wolf list is unfollowed. */
	const stops = new Map<string, AbortController>();

	async function follow(client: ConsoleClient, wolf: string, signal: AbortSignal): Promise<void> {
		let attempt = 0;
		while (!signal.aborted) {
			try {
				// The first frame (the baseline) proves the connection; every later frame is a change. Both poke.
				for await (const ev of client.watchActivity!(wolf, { signal, ...(opts.idleMs ? { idleMs: opts.idleMs } : {}) })) {
					attempt = 0;
					poke(wolf, changeOf(ev));
				}
			} catch {
				/* retry below */
			}
			if (signal.aborted) break;
			await abortableSleep(backoff[Math.min(attempt++, backoff.length - 1)]!, signal);
		}
		following.delete(wolf);
		stops.delete(wolf);
	}

	function refreshWolves(client: ConsoleClient): Promise<void> {
		wolvesPending ??= client
			.listWolves()
			.then((list) => {
				wolves = list.map((w) => w.name);
				wolvesAt = Date.now();
			})
			.catch(() => {})
			.finally(() => {
				wolvesPending = undefined;
			});
		return wolvesPending;
	}

	return {
		ensure(client: ConsoleClient): void {
			if (!client.watchActivity || ctl.signal.aborted) return;
			const start = () => {
				for (const [wolf, stop] of stops) if (!wolves.includes(wolf)) stop.abort(); // no longer listed
				for (const wolf of wolves) {
					if (following.has(wolf)) continue;
					following.add(wolf);
					const stop = new AbortController();
					const cascade = () => stop.abort();
					ctl.signal.addEventListener("abort", cascade, { once: true });
					// An unfollowed wolf must not leave its cascade listener on the long-lived bridge signal.
					stop.signal.addEventListener("abort", () => ctl.signal.removeEventListener("abort", cascade), { once: true });
					stops.set(wolf, stop);
					void follow(client, wolf, stop.signal);
				}
			};
			if (Date.now() - wolvesAt < ttl) return start();
			void refreshWolves(client).then(start);
		},
		stop: () => ctl.abort(),
		get following(): ReadonlySet<string> {
			return following;
		},
	};
}

// Process-wide on globalThis for the same reason as the event bus (Next compiles each route as its own module).
const BRIDGE = Symbol.for("wolfpack.console.activityBridge");
type Holder = { [BRIDGE]?: ReturnType<typeof createActivityBridge> };

export function activityBridge(): ReturnType<typeof createActivityBridge> {
	const g = globalThis as Holder;
	return (g[BRIDGE] ??= createActivityBridge());
}

/** The api bound to the process-wide client; listing also (re)starts the activity bridge. */
export function needsYouApi() {
	return createNeedsYouApi(getConsoleClient, { onList: (client) => activityBridge().ensure(client) });
}
