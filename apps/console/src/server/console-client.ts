/**
 * THE CONSOLE CLIENT FACTORY: the one place that decides which ConsoleClient
 * implementation the console talks to: an HttpConsoleClient against a real
 * wolf's /v1 when WOLFPACK_API_URL is set, otherwise the MockConsoleClient
 * from @wolfpack/client (the default; tests and offline dev).
 *
 * A process-wide singleton (pinned on globalThis so dev HMR and the separate
 * route bundles share ONE instance): a turn started by one request must be
 * watchable/resumable by the next — the mock's thread state lives inside it.
 */

import { HttpConsoleClient, MockConsoleClient, type ConsoleClient } from "@wolfpack/client";
import { bearerOf } from "../core/hub-auth.ts";

const KEY = Symbol.for("wolfpack.console.client");

type Holder = { [KEY]?: ConsoleClient };

/** The work reads a hub can serve. */
export type WorkReads = Pick<ConsoleClient, "listWork" | "getWorkRecord">;

/**
 * `base` with its work reads answered by `work`; every other member is `base`'s own (methods bound to it, so its internal state
 * stays on it). A typed composition, not a patch: `base` is never mutated.
 */
export function composeWorkReads(base: ConsoleClient, work: WorkReads): ConsoleClient {
	return new Proxy(base, {
		get(target, prop) {
			if (prop === "listWork" || prop === "getWorkRecord") return work[prop]?.bind(work);
			const v = Reflect.get(target, prop, target) as unknown;
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
}

/** The bearer token the browser forwarded on the current request, if any (installed by Next's `headers()`; tests inject their own). */
export type RequestToken = () => Promise<string | undefined>;

export const nextRequestToken: RequestToken = async () => {
	try {
		const { headers } = await import("next/headers");
		return bearerOf((await headers()).get("authorization"));
	} catch {
		return undefined; // no request scope (tests, scripts, startup)
	}
};

/**
 * Work reads against the hub with a PER-REQUEST token: the browser's forwarded bearer when present, else the env token / legacy key
 * (server-side and dev path). One small client per token, cached.
 */
export function requestScopedWork(hub: { baseUrl: string; token?: string; apiKey?: string }, requestToken: RequestToken): WorkReads {
	const clients = new Map<string, ConsoleClient>();
	const forToken = (t: string | undefined): ConsoleClient => {
		const key = t ?? "";
		let c = clients.get(key);
		if (!c) {
			if (clients.size >= 32) clients.delete(clients.keys().next().value as string);
			c = new HttpConsoleClient({ baseUrl: hub.baseUrl, hub: t ? { baseUrl: hub.baseUrl, token: t } : hub });
			clients.set(key, c);
		}
		return c;
	};
	return {
		listWork: async (wolf, q) => forToken(await requestToken()).listWork!(wolf, q),
		getWorkRecord: async (wolf, id) => forToken(await requestToken()).getWorkRecord!(wolf, id),
	};
}

/**
 * Build a client from the environment (exported for tests; no singleton).
 *
 *   WOLFPACK_API_URL   a wolf's /v1 (otherwise the mock)
 *   WOLFPACK_HUB_URL   a hubd /v1: work reads (list + record) go there instead of the wolf (optional)
 *   WOLFPACK_HUB_TOKEN the hub bearer token from `hubd pair` (optional; preferred)
 *   WOLFPACK_HUB_KEY   LEGACY: the hub's X-API-Key (optional; ignored when a token is set)
 */
export function createConsoleClient(env: Record<string, string | undefined> = process.env, requestToken?: RequestToken): ConsoleClient {
	const baseUrl = env.WOLFPACK_API_URL?.trim();
	const hubUrl = env.WOLFPACK_HUB_URL?.trim();
	const hub = hubUrl ? { baseUrl: hubUrl, token: env.WOLFPACK_HUB_TOKEN?.trim() || undefined, apiKey: env.WOLFPACK_HUB_KEY?.trim() || undefined } : undefined;
	const withToken = (c: ConsoleClient): ConsoleClient => (hub && requestToken ? composeWorkReads(c, requestScopedWork(hub, requestToken)) : c);
	if (baseUrl) return withToken(new HttpConsoleClient({ baseUrl, ...(hub ? { hub } : {}) }));
	if (!hub) return new MockConsoleClient();
	// No wolf configured, a hub is: threads stay on the mock; work reads come from the hub. The reader's own baseUrl is the hub's
	// and moot: the composition exposes only its two work reads, which target `hub` explicitly.
	if (requestToken) return composeWorkReads(new MockConsoleClient(), requestScopedWork(hub, requestToken));
	return composeWorkReads(new MockConsoleClient(), new HttpConsoleClient({ baseUrl: hub.baseUrl, hub }));
}

export function getConsoleClient(): ConsoleClient {
	const holder = globalThis as Holder;
	holder[KEY] ??= createConsoleClient(process.env, nextRequestToken);
	return holder[KEY];
}

/** Test seam: replace (or clear, with undefined) the process singleton. */
export function setConsoleClient(client: ConsoleClient | undefined): void {
	(globalThis as Holder)[KEY] = client;
}
