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

import { HttpConsoleClient, MockConsoleClient, ProtocolError, type ConsoleClient } from "@wolfpack/client";
import { bearerOf } from "../core/hub-auth.ts";
import { defaultDirectRoute, type DirectRoute } from "./direct-path.ts";
import { isRelayMode } from "./relay-mode.ts";
import { sessionWitness } from "./session-witness.ts";

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
 *   undefined NO request scope at all (background/server jobs, startup): also unpaired; the env token never stands in
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
		return bearerOf(h.get("authorization")) ?? null; // bearer only: the proxy (proxy.ts) turns a mirrored cookie into a bearer for GET/HEAD navigations
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
 * With a `requestToken` resolver there is NO fallback at all (no scope = unpaired = 401). Only a resolver-less client (tests, scripts)
 * sends the env token (WOLFPACK_HUB_TOKEN). Each outcome is reported to the session witness (pack health's offline auth). One small client per token, cached: each client
 * holds nothing but its own base URL and token (no response or per-user state), so the cache cannot carry data between tokens.
 */
export function requestScopedWork(hub: { baseUrl: string; token?: string }, requestToken: RequestToken): WorkReads {
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
		if (!t) throw new HubAuthError("this browser is not paired with the hub (no bearer token)"); // no scope counts as unpaired too: the env token never serves a user call
		try {
			const out = await fn(forToken(t));
			sessionWitness().verified(t); // the hub accepted this browser: pack health may trust it while the hub is down
			return out;
		} catch (err) {
			if (err instanceof Error && err.name === "ProtocolError" && (err as Error & { code?: string }).code === "unauthorized") {
				sessionWitness().rejected(t);
				throw new HubAuthError(err.message);
			}
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
 * to the wolf's host over its worker link. Credentials are per request exactly as in `requestScopedWork`: with a resolver, no token (or no scope) is a 401 and
 * the client holds no token of its own (createConsoleClient strips the env token); a resolver-less client uses `hub.token`. One HttpConsoleClient per token, cached.
 */
export function relayClient(hub: { baseUrl: string; token?: string }, requestToken?: RequestToken): ConsoleClient {
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
	const resolve = async (): Promise<{ c: ConsoleClient; t?: string }> => {
		const t = requestToken ? await requestToken() : undefined;
		if (requestToken && !t) throw new HubAuthError("this browser is not paired with the hub (no bearer token)");
		return { c: forToken(t ?? undefined), ...(t ? { t } : {}) };
	};
	const mapAuth = (err: unknown, t?: string): never => {
		if (err instanceof Error && err.name === "ProtocolError" && (err as Error & { code?: string }).code === "unauthorized") {
			if (t) sessionWitness().rejected(t);
			throw new HubAuthError(err.message);
		}
		throw err;
	};
	const fallback = forToken(undefined);
	return new Proxy(fallback, {
		get(_target, prop) {
			const v = Reflect.get(fallback, prop, fallback) as unknown;
			if (typeof v !== "function" || typeof prop !== "string") return v;
			if (STREAMS.has(prop)) {
				return async function* (...args: unknown[]) {
					const { c, t } = await resolve().catch((e: unknown) => mapAuth(e));
					try {
						yield* (Reflect.get(c, prop, c) as (...a: unknown[]) => AsyncIterable<unknown>).apply(c, args);
					} catch (e) {
						mapAuth(e, t);
					}
				};
			}
			return async (...args: unknown[]) => {
				const { c, t } = await resolve().catch((e: unknown) => mapAuth(e));
				try {
					const out = await (Reflect.get(c, prop, c) as (...a: unknown[]) => unknown).apply(c, args);
					if (t) sessionWitness().verified(t); // see requestScopedWork
					return out;
				} catch (e) {
					return mapAuth(e, t);
				}
			};
		},
	}) as ConsoleClient;
}

/** What the direct path can serve, by the argument that names the wolf: none (listWolves), the wolf name, or a `<wolf>/<rest>` thread id. */
// Not here on purpose (direct-path.ts WHAT): putPrompt, resetPrompt, putWolfSettings, revealWolfSetting and putThreadSettings stay behind
// the hub's live device check. restartWolf stays: restarting a local wolf is recovery, the point of the fallback.
const DIRECT_BY_WOLF = new Set(["listThreads", "createThread", "listPrompts", "getWolfSettings", "restartWolf", "listCards", "watchMemory", "watchActivity", "consolidateMemory", "getMemoryStatus", "getMemoryObservations", "getMemoryTopic"]);
const DIRECT_BY_THREAD = new Set(["getThread", "listChildren", "getLedger", "getWorkspaceStatus", "submit", "uploadAttachment", "getAttachment", "answerCard", "saveCardPage", "submitCard", "putCardNote", "bindCardText", "getDiagram", "skipCard", "getThreadSettings", "getThreadContext", "compactThread", "abort", "watch"]);
/** Streams whose last argument is `{signal}`: a direct stream is ended when the route goes back to the hub, so its consumer reconnects through the hub. */
const DIRECT_STREAMS_WITH_SIGNAL: Record<string, number> = { watch: 1, watchMemory: 1, watchActivity: 1 };

/**
 * A failure that is the hub not answering (network error, refused, reset, timeout), as opposed to any answer from it (ProtocolError,
 * NotFoundError, BusyError, 401/HubAuthError) or the caller giving up (AbortError). One ProtocolError is the client's own, not the hub's:
 * a stream whose reconnects all failed ("stream lost: ...").
 */
const isUnreachable = (e: unknown): boolean => {
	if (!(e instanceof Error)) return true;
	if (e instanceof HubAuthError || e.name === "AbortError") return false;
	if (e.name === "ProtocolError") return (e as Error & { code?: string }).code === "engine_error" && e.message.startsWith("stream lost:");
	return e.name !== "NotFoundError" && e.name !== "BusyError";
};

const unavailable = (what: string) => new ProtocolError("engine_error", `the hub is unreachable; only this machine's wolves are available (${what})`, true);

/**
 * FALLBACK ONLY (work-wolfpack-Fy45EOA): `hub` (the relay client) stays the primary path. A call goes to the local workerd (`direct`)
 * when the monitor's route is "direct", or when the hub call fails WITHOUT an answer (network error, timeout) and a live monitor round
 * then finds hubd down while the direct link answers. A hub answer of any kind (401 included) is final. On the direct path:
 *   - the browser's bearer must be one the hub accepted through this console recently (the session witness, as pack-health restarts);
 *     otherwise 401 (HubAuthError), and the local workerd is not contacted;
 *   - only the wolves the local workerd lists are served (wolf- and thread-scoped chat routes); anything else, including every hub-only
 *     route (work, KB, devices, hub events), is ProtocolError engine_error retryable "the hub is unreachable": unavailable, not an error page.
 */
export function withDirect(hub: ConsoleClient, direct: DirectRoute, requestToken: RequestToken): ConsoleClient {
	const authorise = async (): Promise<void> => {
		const t = await requestToken();
		if (!t || !sessionWitness().isRecent(t, direct.sessionTtlMs)) throw new HubAuthError("the hub is unreachable and this browser has no recently verified hub session");
	};
	const wolfOf = (prop: string, args: unknown[]): string | undefined | null => {
		if (prop === "listWolves") return undefined;
		const a = args[0];
		if (typeof a !== "string") return null;
		if (DIRECT_BY_WOLF.has(prop)) return a;
		if (DIRECT_BY_THREAD.has(prop)) {
			const i = a.indexOf("/");
			return i > 0 ? a.slice(0, i) : null;
		}
		return null;
	};
	/** Checks auth and scope, then the direct client's bound method. */
	const directMethod = async (prop: string, args: unknown[]): Promise<(...a: unknown[]) => unknown> => {
		await authorise();
		const wolf = wolfOf(prop, args);
		if (wolf === null) throw unavailable(prop);
		if (wolf !== undefined && !direct.owns(wolf)) throw unavailable(`wolf ${wolf} is on another host`);
		const fn = Reflect.get(direct.client, prop, direct.client) as unknown;
		if (typeof fn !== "function") throw unavailable(prop);
		return (fn as (...a: unknown[]) => unknown).bind(direct.client);
	};
	/** For a direct stream: end it when the route goes back to the hub (checked on every event and every few seconds). */
	const untilHubBack = (prop: string, args: unknown[]): { args: unknown[]; stop: () => void } => {
		const at = DIRECT_STREAMS_WITH_SIGNAL[prop];
		if (at === undefined) return { args, stop: () => {} };
		const opts = (args[at] as { signal?: AbortSignal } | undefined) ?? {};
		const ctl = new AbortController();
		const timer = setInterval(() => direct.route() === "hub" && ctl.abort(), 2000);
		timer.unref?.();
		const signal = opts.signal ? AbortSignal.any([opts.signal, ctl.signal]) : ctl.signal;
		const out = [...args];
		out[at] = { ...opts, signal };
		return { args: out, stop: () => clearInterval(timer) };
	};
	return new Proxy(hub, {
		get(_target, prop) {
			const v = Reflect.get(hub, prop, hub) as unknown;
			if (typeof v !== "function" || typeof prop !== "string") return v;
			if (STREAMS.has(prop)) {
				return async function* (...args: unknown[]) {
					if (direct.route() !== "direct") {
						let yielded = false;
						try {
							for await (const ev of (v as (...a: unknown[]) => AsyncIterable<unknown>).apply(hub, args)) {
								yielded = true;
								yield ev;
							}
							return;
						} catch (e) {
							// Only a stream that never got going falls back (one that did resumes through its own reconnects/consumer).
							if (yielded || !isUnreachable(e) || (await direct.check()) !== "direct") throw e;
						}
					}
					const fn = await directMethod(prop, args);
					const s = untilHubBack(prop, args);
					try {
						for await (const ev of fn(...s.args) as AsyncIterable<unknown>) {
							yield ev;
							if (direct.route() === "hub") return;
						}
					} finally {
						s.stop();
					}
				};
			}
			return async (...args: unknown[]) => {
				if (direct.route() !== "direct") {
					try {
						return await (v as (...a: unknown[]) => unknown).apply(hub, args);
					} catch (e) {
						if (!isUnreachable(e) || (await direct.check()) !== "direct") throw e;
					}
				}
				return (await directMethod(prop, args))(...args);
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
 *   (WOLFPACK_HUB_KEY, the old shared X-API-Key, is no longer read; a warning is logged if it is still set)
 *
 * `direct` (relay mode with a request-token resolver only): the fallback to the local workerd while the hub is unreachable (withDirect).
 */
export function createConsoleClient(env: Record<string, string | undefined> = process.env, requestToken?: RequestToken, direct?: DirectRoute): ConsoleClient {
	const baseUrl = env.WOLFPACK_API_URL?.trim();
	const hubUrl = env.WOLFPACK_HUB_URL?.trim();
	// With a per-request resolver the client holds NO hub token at all (no super-token by construction); WOLFPACK_HUB_TOKEN is read only for resolver-less
	// callers (scripts, tests), here.
	const hub = hubUrl ? { baseUrl: hubUrl, token: requestToken ? undefined : env.WOLFPACK_HUB_TOKEN?.trim() || undefined } : undefined;
	if (env.WOLFPACK_HUB_KEY?.trim()) console.warn("console: WOLFPACK_HUB_KEY is no longer supported and is ignored; set WOLFPACK_HUB_TOKEN (from `hubd pair`)");
	const haveToken = !!requestToken || !!hub?.token;
	if (hub && isRelayMode(env, haveToken)) {
		const relay = relayClient(hub, requestToken);
		return direct && requestToken ? withDirect(relay, direct, requestToken) : relay;
	}
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
	holder[KEY] ??= createConsoleClient(process.env, nextRequestToken, defaultDirectRoute(process.env));
	return holder[KEY];
}

/** Test seam: replace (or clear, with undefined) the process singleton. */
export function setConsoleClient(client: ConsoleClient | undefined): void {
	(globalThis as Holder)[KEY] = client;
}
