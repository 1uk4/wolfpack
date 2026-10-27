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

import type { ConsoleClient } from "@wolfpack/client";
import { buildNeedsYou, type WolfNeedsYou } from "../core/needs-you.ts";
import { emit } from "../core/events.ts";
import { getConsoleClient } from "./console-client.ts";
import type { ClientSource } from "./thread-api.ts";

/**
 * Pending cards and thread titles of every wolf (or just `only`). `responded` names the wolves that answered: an
 * unreachable wolf is absent from both, and the caller must not conclude its cards are gone.
 */
export async function collectNeedsYou(client: ConsoleClient, only?: string): Promise<{ reports: WolfNeedsYou[]; responded: string[] }> {
	if (!client.listCards) return { reports: [], responded: [] };
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
	return { reports: ok, responded: ok.map((r) => r.wolf) };
}

export function createNeedsYouApi(source: ClientSource, opts: { onList?: (client: ConsoleClient) => void } = {}) {
	return {
		/** `wolf`: only that wolf (the poked-wolf refetch). Answers `{items, responded}`. */
		async list(wolf?: string): Promise<Response> {
			try {
				const client = source();
				opts.onList?.(client);
				const { reports, responded } = await collectNeedsYou(client, wolf);
				return Response.json({ items: buildNeedsYou(reports), responded });
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

/**
 * Follow every wolf's activity stream and poke the bus on each change. `ensure` is cheap and idempotent (the wolf list is
 * cached; a followed wolf is not followed twice). A stream that ends or gives up is retried with backoff, and every
 * (re)start pokes once: events in the gap may have been missed (or resynced), so consumers refetch.
 */
export function createActivityBridge(poke: (wolf: string) => void = (wolf) => emit("needs-you-changed", { wolf }), opts: BridgeOptions = {}) {
	const backoff = opts.backoffMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];
	const ttl = opts.wolvesTtlMs ?? 30_000;
	const following = new Set<string>();
	const ctl = new AbortController();
	let wolves: string[] = [];
	let wolvesAt = 0;
	let wolvesPending: Promise<void> | undefined;

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			const t = setTimeout(resolve, ms);
			ctl.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
		});

	async function follow(client: ConsoleClient, wolf: string): Promise<void> {
		let attempt = 0;
		while (!ctl.signal.aborted) {
			try {
				poke(wolf); // (re)connected: refetch truth, the gap may hold changes
				for await (const _ev of client.watchActivity!(wolf, { signal: ctl.signal, ...(opts.idleMs ? { idleMs: opts.idleMs } : {}) })) {
					attempt = 0;
					poke(wolf);
				}
			} catch {
				/* retry below */
			}
			if (ctl.signal.aborted) break;
			await sleep(backoff[Math.min(attempt++, backoff.length - 1)]!);
		}
		following.delete(wolf);
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
				for (const wolf of wolves) {
					if (following.has(wolf)) continue;
					following.add(wolf);
					void follow(client, wolf);
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
