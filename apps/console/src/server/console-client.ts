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

/**
 * The bearer the browser forwarded on the current request:
 *   string    a token was sent
 *   null      there IS a request scope but no (usable) Authorization header: the caller is not paired
 *   undefined NO request scope at all (background/server jobs, tests, startup): only then may the env token be used
 */
export type RequestToken = () => Promise<string | null | undefined>;

export const nextRequestToken: RequestToken = async () => {
	let h: Headers;
	try {
		const { headers } = await import("next/headers");
		h = await headers();
	} catch {
		return undefined; // outside a request (headers() throws)
	}
	return bearerOf(h.get("authorization")) ?? null;
};

/** A hub authentication failure as the routes see it: a ProtocolError(unauthorized) tagged `hubAuth`, which memory-api answers 401 + X-Wolfpack-Hub-Auth. */
export class HubAuthError extends Error {
	readonly code = "unauthorized";
	readonly hubAuth = true;
	constructor(message: string) {
		super(message);
		this.name = "ProtocolError"; // routes match errors by name (Next bundles the client per route)
	}
}

/**
 * Work reads against the hub with a PER-REQUEST token. Inside a request scope only the browser's forwarded token is used; no token
 * rejects (the route answers 401, the browser goes to /pair): the env token/key never stands in for a request that did not authenticate.
 * The env credentials serve only callers with NO request scope (background jobs). One small client per token, cached: each client
 * holds nothing but its own base URL and token (no response or per-user state), so the cache cannot carry data between tokens.
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
	const run = async <T>(fn: (c: ConsoleClient) => Promise<T>): Promise<T> => {
		const t = await requestToken();
		if (t === null) throw new HubAuthError("this browser is not paired with the hub (no bearer token)");
		try {
			return await fn(forToken(t));
		} catch (err) {
			if (err instanceof Error && err.name === "ProtocolError" && (err as Error & { code?: string }).code === "unauthorized") throw new HubAuthError(err.message);
			throw err;
		}
	};
	return {
		listWork: (wolf, q) => run((c) => c.listWork!(wolf, q)),
		getWorkRecord: (wolf, id) => run((c) => c.getWorkRecord!(wolf, id)),
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
