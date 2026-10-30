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

/** Next's "called outside a request scope" error (the only failure that means "no request"). */
export const isOutsideRequestScope = (e: unknown): boolean => e instanceof Error && /was called outside a request scope/.test(e.message);

/** `getHeaders` is Next's `headers()` (injected for tests). Fails CLOSED: only the outside-a-request error is `undefined`; any other failure is `null` (-> 401). */
export function makeRequestToken(getHeaders: () => Promise<Headers>): RequestToken {
	return async () => {
		let h: Headers;
		try {
			h = await getHeaders();
		} catch (e) {
			return isOutsideRequestScope(e) ? undefined : null;
		}
		return bearerOf(h.get("authorization")) ?? null;
	};
}

export const nextRequestToken: RequestToken = async () => {
	let getHeaders: () => Promise<Headers>;
	try {
		const { headers } = await import("next/headers");
		getHeaders = async () => headers();
	} catch {
		return null; // cannot even load Next's request API: do not assume "no request"
	}
	return makeRequestToken(getHeaders)();
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

const STREAMS = new Set(["watch", "watchMemory", "watchActivity", "watchHubEvents"]);

/**
 * RELAY MODE: the whole ConsoleClient (threads, chat, streams, memory, KB, work) talks to the HUB only, which tunnels wolf-scoped requests
 * to the wolf's host over its worker link. Credentials are per request exactly as in `requestScopedWork` (a request scope with no token is
 * 401; the env token serves only scope-less callers). One HttpConsoleClient per token, cached.
 */
export function relayClient(hub: { baseUrl: string; token?: string; apiKey?: string }, requestToken?: RequestToken): ConsoleClient {
	const clients = new Map<string, ConsoleClient>();
	const forToken = (t: string | undefined): ConsoleClient => {
		const key = t ?? "";
		let c = clients.get(key);
		if (!c) {
			if (clients.size >= 32) clients.delete(clients.keys().next().value as string);
			const h = t ? { baseUrl: hub.baseUrl, token: t, relay: true } : { ...hub, relay: true };
			c = new HttpConsoleClient({ baseUrl: hub.baseUrl, hub: h });
			clients.set(key, c);
		}
		return c;
	};
	const resolve = async (): Promise<ConsoleClient> => {
		const t = requestToken ? await requestToken() : undefined;
		if (t === null) throw new HubAuthError("this browser is not paired with the hub (no bearer token)");
		return forToken(t);
	};
	const mapAuth = (err: unknown): never => {
		if (err instanceof Error && err.name === "ProtocolError" && (err as Error & { code?: string }).code === "unauthorized") throw new HubAuthError(err.message);
		throw err;
	};
	const fallback = forToken(undefined);
	return new Proxy(fallback, {
		get(_target, prop) {
			const v = Reflect.get(fallback, prop, fallback) as unknown;
			if (typeof v !== "function" || typeof prop !== "string") return v;
			if (STREAMS.has(prop)) {
				return async function* (...args: unknown[]) {
					const c = await resolve().catch(mapAuth);
					try {
						yield* (Reflect.get(c, prop, c) as (...a: unknown[]) => AsyncIterable<unknown>).apply(c, args);
					} catch (e) {
						mapAuth(e);
					}
				};
			}
			return async (...args: unknown[]) => {
				const c = await resolve().catch(mapAuth);
				try {
					return await (Reflect.get(c, prop, c) as (...a: unknown[]) => unknown).apply(c, args);
				} catch (e) {
					return mapAuth(e);
				}
			};
		},
	}) as ConsoleClient;
}

/**
 * Build a client from the environment (exported for tests; no singleton).
 *
 *   WOLFPACK_API_URL   a wolf's /v1 (otherwise the mock)
 *   WOLFPACK_HUB_URL   a hubd /v1: work reads (list + record) go there instead of the wolf (optional)
 *   WOLFPACK_HUB_TOKEN the hub bearer token from `hubd pair` (optional; preferred)
 *   WOLFPACK_HUB_RELAY RELAY MODE: everything (chat, streams, memory, KB, work) goes through the hub, which tunnels to the wolf's host.
 *                      DEFAULT when a hub URL is set with a token (env, or the browser's per-request token) and no WOLFPACK_API_URL (no
 *                      direct wolf host). 0/false/no: never relay (the old hub-for-work-reads-only mode). 1/true: relay even when
 *                      WOLFPACK_API_URL is set (that URL is then unused).
 *   WOLFPACK_HUB_KEY   LEGACY: the hub's X-API-Key (optional; ignored when a token is set)
 */
export function createConsoleClient(env: Record<string, string | undefined> = process.env, requestToken?: RequestToken): ConsoleClient {
	const baseUrl = env.WOLFPACK_API_URL?.trim();
	const hubUrl = env.WOLFPACK_HUB_URL?.trim();
	const hub = hubUrl ? { baseUrl: hubUrl, token: env.WOLFPACK_HUB_TOKEN?.trim() || undefined, apiKey: env.WOLFPACK_HUB_KEY?.trim() || undefined } : undefined;
	const flag = env.WOLFPACK_HUB_RELAY?.trim() ?? "";
	const off = /^(0|false|no|off)$/i.test(flag);
	const forced = /^(1|true|yes|on)$/i.test(flag);
	const haveToken = !!(hub?.token || hub?.apiKey || requestToken);
	if (hub && !off && (forced || (!baseUrl && haveToken))) return relayClient(hub, requestToken);
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
