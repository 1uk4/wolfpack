/**
 * THE DIRECT PATH (work-wolfpack-Fy45EOA): while the hub is unreachable, a console on the same machine as a workerd talks to that
 * workerd's loopback-only /direct/v1 (the same /v1 API the hub relays to it), authenticated with workerd's local token
 * (pack-health.ts DIRECT PATH; packages/workerd/src/direct-token.ts). The pack-health monitor decides the route; this module builds the
 * client for it. The fallback itself is console-client.ts `withDirect`.
 *
 * WHEN: the route is "direct" only after 2 consecutive pack-health rounds in which hubd does not answer while the direct link does, and
 * goes back to "hub" after 2 consecutive answering rounds. A hub call that fails without an answer (network error, timeout; never a
 * caller's abort, never any hub answer such as a 401) runs one live round (`check`), which counts as one of those rounds. Live rounds
 * are debounced: at most one per CHECK_DEBOUNCE_MS (2 s); inside the window the last route is reused, so a burst of failing calls
 * cannot turn into a burst of hub probes. So a hub that fails live switches to direct only after 2 failed rounds: a live check plus
 * the next 5 s monitor round (WOLFPACK_HEALTH_INTERVAL_MS), or two live checks at least 2 s apart. Until then calls fail with the
 * retryable "hub unreachable" error. That is deliberate: one failed call or probe never flips the route (no flapping).
 *
 * WHO: a browser may use the direct path only if the hub accepted its bearer through this console within the last
 * WOLFPACK_DIRECT_SESSION_TTL_H hours (default 24; the session witness, which keeps entries for the 72 h of pack-health restarts,
 * WOLFPACK_HEALTH_SESSION_TTL_H). Otherwise 401, and the local workerd is not contacted.
 *
 * WHAT: chat, threads, streams and reads of the wolves the local workerd lists. Not served (a retryable engine_error "the hub is
 * unreachable", the same as for hub-only routes such as work, KB, devices and hub events): other hosts' wolves, and the settings and
 * prompt writes and secret reveals (`putWolfSettings`, `putPrompt`, `resetPrompt`, `revealWolfSetting`, `putThreadSettings`), which
 * stay behind the hub's live device check. `restartWolf` IS served: restarting a local wolf is recovery, the point of the fallback.
 * A direct stream ends when the route goes back to the hub, so its consumer reconnects through the hub.
 *
 * EXPOSURE: workerd refuses /direct* from a non-loopback peer and from any request carrying forwarding headers (X-Forwarded-*,
 * Forwarded, Via). A raw TCP forward to 127.0.0.1 (e.g. `tailscale serve --tcp`, `socat`, an ssh -L tunnel) adds no headers and
 * looks like loopback, so only the token protects that case: never set one up to workerd's port.
 */
import { HttpConsoleClient, ProtocolError, type ConsoleClient } from "@wolfpack/client";
import { packHealth } from "./health-api.ts";
import { DIRECT_TOKEN_HEADER, directTarget, readDirectToken, type DirectTarget, type PackHealth, type Route } from "./pack-health.ts";

export { directTarget };

/** At most one live check per this window; inside it `check()` returns the last route. */
export const CHECK_DEBOUNCE_MS = 2000;
export const DEFAULT_DIRECT_SESSION_TTL_MS = 24 * 3600_000;

export interface DirectRoute {
	/** The monitor's current route. */
	route(): Route;
	/** A live check (one monitor round, shared with any running one, debounced); resolves with the route after it. */
	check(): Promise<Route>;
	/** May the direct path serve this wolf? Only the wolves the local workerd listed. */
	owns(wolf: string): boolean;
	/** How recently the hub must have accepted a browser for it to use the direct path. */
	sessionTtlMs: number;
	/** The client against the local workerd. */
	client: ConsoleClient;
}

export function directRoute(health: PackHealth, target: DirectTarget, o: { fetch?: typeof fetch; sessionTtlMs?: number; now?: () => number } = {}): DirectRoute {
	const fetchFn = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
	const now = o.now ?? Date.now;
	const client = new HttpConsoleClient({
		baseUrl: `${target.url}/direct`,
		fetch: (input, init) => {
			const token = readDirectToken(target.tokenFile);
			if (!token) return Promise.reject(new ProtocolError("engine_error", "the local workerd's direct token is missing", true));
			const headers = new Headers(init?.headers);
			headers.set(DIRECT_TOKEN_HEADER, token);
			return fetchFn(input, { ...init, headers });
		},
	});
	let lastCheck = -Infinity;
	let pending: Promise<Route> | undefined;
	return {
		route: () => health.route(),
		check: () => {
			if (pending) return pending;
			if (now() - lastCheck < CHECK_DEBOUNCE_MS) return Promise.resolve(health.route());
			lastCheck = now();
			pending = health.tick().then((s) => s.route).finally(() => {
				pending = undefined;
			});
			return pending;
		},
		owns: (wolf) => health.localWolves().has(wolf),
		sessionTtlMs: o.sessionTtlMs ?? DEFAULT_DIRECT_SESSION_TTL_MS,
		client,
	};
}

const KEY = Symbol.for("wolfpack.console.directRoute");
type Holder = { [KEY]?: DirectRoute | null };

/** The process-wide direct route over the shared monitor, or undefined when WOLFPACK_WORKERD_DIRECT_URL is not set. */
export function defaultDirectRoute(env: Record<string, string | undefined> = process.env): DirectRoute | undefined {
	const h = globalThis as Holder;
	if (h[KEY] === undefined) {
		const target = directTarget(env);
		const ttlH = Number(env.WOLFPACK_DIRECT_SESSION_TTL_H);
		h[KEY] = target ? directRoute(packHealth(env), target, ttlH > 0 ? { sessionTtlMs: ttlH * 3600_000 } : {}) : null;
	}
	return h[KEY] ?? undefined;
}
