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

/** Every wolf's pending cards and thread titles. */
export async function collectNeedsYou(client: ConsoleClient): Promise<WolfNeedsYou[]> {
	if (!client.listCards) return [];
	const wolves = await client.listWolves();
	const reports = await Promise.all(
		wolves.map(async (w): Promise<WolfNeedsYou | null> => {
			try {
				const [cards, threads] = await Promise.all([client.listCards!(w.name), client.listThreads(w.name)]);
				return { wolf: w.name, cards, threads };
			} catch {
				return null;
			}
		}),
	);
	return reports.filter((r): r is WolfNeedsYou => r !== null);
}

export function createNeedsYouApi(source: ClientSource, opts: { onList?: (client: ConsoleClient) => void } = {}) {
	return {
		async list(): Promise<Response> {
			try {
				const client = source();
				opts.onList?.(client);
				return Response.json({ items: buildNeedsYou(await collectNeedsYou(client)) });
			} catch (err) {
				return Response.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: 500 });
			}
		},
	};
}

/**
 * Follow every wolf's activity stream and poke the bus on each change. Idempotent per wolf (a wolf already followed is
 * not followed twice) and safe to call on every list request, which is how newly listed wolves get picked up. A stream
 * that gives up is dropped from the set so the next call restarts it. Returns a stop function.
 */
export function createActivityBridge(poke: (wolf: string) => void = (wolf) => emit("needs-you-changed", { wolf })) {
	const following = new Set<string>();
	const ctl = new AbortController();
	return {
		ensure(client: ConsoleClient): void {
			const watch = client.watchActivity?.bind(client);
			if (!watch || ctl.signal.aborted) return;
			void client
				.listWolves()
				.then((wolves) => {
					for (const w of wolves) {
						if (following.has(w.name)) continue;
						following.add(w.name);
						void (async () => {
							for await (const _ev of watch(w.name, { signal: ctl.signal })) poke(w.name);
						})()
							.catch(() => {})
							.finally(() => following.delete(w.name));
					}
				})
				.catch(() => {});
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
