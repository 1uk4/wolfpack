/**
 * THE PACK HEALTH API (work-wolfpack-LUQ7C2B). The reads never call the hub; only the restart's auth check may.
 *   GET  /api/health          snapshot of every link (unauthenticated, like the services' own /healthz: names, states, short error
 *                             codes and numbers only). Always 200 while the console runs, whatever the hub's state.
 *                             Versions, wolf names and timings are intentionally visible to the tailnet without auth (accepted).
 *   GET  /api/health/stream   SSE: the snapshot now and after every probe round (`data: <HealthSnapshot>`), `: ping` every 25 s
 *   POST /api/health/restart  {service: "hubd" | "workerd" | "wolfd@<name>"}; needs `Authorization: Bearer <device token>`.
 *                             202 {ok, service, at} | 400 invalid_request | 401 unauthorized | 429 rate_limited (+Retry-After) | 502 failed
 *
 * RESTART AUTH. The hub decides whenever it can: every attempt first checks the bearer LIVE, whatever the monitor currently thinks
 * of hubd, with the cheap authenticated call the console's hub client already makes (GET <hub>/v1/wolves: hubTarget().wolvesUrl,
 * the same hub the monitor probes; the browser's own token, never the console's; 3 s timeout).
 *   - 2xx: accepted (and the witness is refreshed).
 *   - 401, 403 and any other 4xx except 408/429: rejected, AND the token is dropped from the witness. hubd answers a revoked
 *     token with 401 `unauthorized` on its next request (auth.ts verify() re-reads tokens.json by stat stamp; the dispatch gate in
 *     server.ts answers 401 before any routing). hubd has no "disabled" token state: revoking is the only way to cut a device off.
 *   - 408, 429, 5xx, network errors, timeouts, no hub URL: no verdict. Only then the session witness decides (session-witness.ts):
 *     the bearer must have been accepted by the hub through this console within WOLFPACK_HEALTH_SESSION_TTL_H (default 72 h). So a
 *     device revoked while the hub is down or frozen keeps restart rights for at most 72 h after its last successful hub call.
 * The live checks are bounded (unauthenticated callers can trigger them): at most MAX_LIVE_CHECKS_IN_FLIGHT at once and
 * MAX_LIVE_CHECKS_PER_MIN started per rolling minute, across all callers. Beyond either the restart is refused with 429
 * rate_limited (Retry-After 5 s for the in-flight cap, until the window frees a slot for the per-minute one) and no hub call is made.
 * The bearer must be the header: the cookie mirror (proxy.ts) never applies to a POST, so a cross-site form cannot restart anything.
 */
import { bearerOf } from "../core/hub-auth.ts";
import { createPackHealth, createRestarter, healthTargets, hubTarget, type PackHealth, type Restarter } from "./pack-health.ts";
import { sessionWitness, type SessionWitness } from "./session-witness.ts";

const NO_STORE = { "Cache-Control": "no-store" };

/** The hub's verdict on a bearer: accepted (2xx), rejected (4xx but 408/429), or no verdict (408, 429, 5xx, network, timeout). */
export type HubVerdict = "accepted" | "rejected" | "unreachable";
export type HubTokenCheck = (token: string) => Promise<HubVerdict>;

export const MAX_LIVE_CHECKS_IN_FLIGHT = 2;
export const MAX_LIVE_CHECKS_PER_MIN = 30;

/** GET `wolvesUrl` (hubTarget().wolvesUrl) with the bearer (any valid token may call it); `timeoutMs` default 3000. No URL: no verdict. */
export function hubTokenCheck(wolvesUrl: string | undefined, o: { timeoutMs?: number; fetch?: typeof fetch } = {}): HubTokenCheck {
	const url = wolvesUrl?.trim();
	return async (token) => {
		if (!url) return "unreachable";
		try {
			const r = await (o.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(o.timeoutMs ?? 3000) });
			await r.body?.cancel().catch(() => {});
			if (r.ok) return "accepted";
			return r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429 ? "rejected" : "unreachable";
		} catch {
			return "unreachable";
		}
	};
}

export interface HealthApiDeps {
	health: PackHealth;
	restarter: Restarter;
	witness: SessionWitness;
	/** Live bearer check against the hub, tried first on every restart (see RESTART AUTH). */
	checkToken: HubTokenCheck;
	now?: () => number;
}

type AuthOutcome = { ok: true } | { ok: false; busy?: undefined } | { ok: false; busy: number };

export function createHealthApi(d: HealthApiDeps) {
	const now = d.now ?? Date.now;
	let inFlight = 0;
	const started: number[] = []; // start times of the live checks in the last minute

	/** See RESTART AUTH above. `busy`: refused by the live-check caps, retry after that many seconds. */
	const authorise = async (token: string): Promise<AuthOutcome> => {
		const t = now();
		while (started.length > 0 && t - started[0]! >= 60_000) started.shift();
		if (inFlight >= MAX_LIVE_CHECKS_IN_FLIGHT) return { ok: false, busy: 5 };
		if (started.length >= MAX_LIVE_CHECKS_PER_MIN) return { ok: false, busy: Math.max(1, Math.ceil((started[0]! + 60_000 - t) / 1000)) };
		inFlight++;
		started.push(t);
		let v: HubVerdict;
		try {
			v = await d.checkToken(token);
		} catch {
			v = "unreachable";
		} finally {
			inFlight--;
		}
		if (v === "accepted") {
			d.witness.verified(token);
			return { ok: true };
		}
		if (v === "rejected") {
			d.witness.rejected(token);
			return { ok: false };
		}
		return d.witness.isRecent(token) ? { ok: true } : { ok: false };
	};

	return {
		/** The current snapshot; before the first round has finished, waits for it so the first answer is real. */
		async get(): Promise<Response> {
			const s = d.health.snapshot().checkedAt === null ? await d.health.tick() : d.health.snapshot();
			return Response.json(s, { headers: NO_STORE });
		},

		stream(signal?: AbortSignal): Response {
			const enc = new TextEncoder();
			let teardown = () => {};
			const body = new ReadableStream<Uint8Array>({
				start(ctl) {
					const close = () => {
						teardown();
						try {
							ctl.close();
						} catch {
							/* already closed */
						}
					};
					if (signal?.aborted) return close(); // the client left before we started: subscribe to nothing
					const send = (chunk: string) => {
						try {
							ctl.enqueue(enc.encode(chunk));
						} catch {
							teardown();
						}
					};
					send(`data: ${JSON.stringify(d.health.snapshot())}\n\n`);
					const off = d.health.subscribe((s) => send(`data: ${JSON.stringify(s)}\n\n`));
					const ping = setInterval(() => send(": ping\n\n"), 25_000);
					teardown = () => {
						off();
						clearInterval(ping);
					};
					signal?.addEventListener("abort", close, { once: true });
				},
				cancel() {
					teardown();
				},
			});
			return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
		},

		async restart(req: Request): Promise<Response> {
			const token = bearerOf(req.headers.get("authorization"));
			const auth: AuthOutcome = token ? await authorise(token) : { ok: false };
			if (!auth.ok && auth.busy !== undefined) {
				return Response.json({ error: "too many restart attempts right now; try again shortly", code: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(auth.busy) } });
			}
			if (!token || !auth.ok) {
				return Response.json({ error: "sign in on this device first (no recently verified device token)", code: "unauthorized" }, { status: 401, headers: NO_STORE });
			}
			let service: unknown;
			try {
				service = ((await req.json()) as { service?: unknown } | null)?.service;
			} catch {
				return Response.json({ error: "body must be JSON {service}", code: "invalid_request" }, { status: 400, headers: NO_STORE });
			}
			const out = await d.restarter.restart(service, `device ${d.witness.fingerprint(token)}`);
			if (out.ok) return Response.json(out, { status: 202, headers: NO_STORE });
			const status = out.code === "invalid_request" ? 400 : out.code === "rate_limited" ? 429 : 502;
			return Response.json({ error: out.message, code: out.code, service: out.service }, { status, headers: { ...NO_STORE, ...(out.retryAfterS ? { "Retry-After": String(out.retryAfterS) } : {}) } });
		},
	};
}

const KEY = Symbol.for("wolfpack.console.packHealth");
const MONITOR = Symbol.for("wolfpack.console.packHealthMonitor");
type Holder = { [KEY]?: ReturnType<typeof createHealthApi>; [MONITOR]?: PackHealth };

/** The process-wide monitor (started on first use; probes every WOLFPACK_HEALTH_INTERVAL_MS, default 5000). The API and the client's direct route share it. */
export function packHealth(env: Record<string, string | undefined> = process.env): PackHealth {
	const h = globalThis as Holder;
	if (!h[MONITOR]) {
		const interval = Number(env.WOLFPACK_HEALTH_INTERVAL_MS);
		h[MONITOR] = createPackHealth({ targets: healthTargets(env), ...(interval >= 1000 ? { intervalMs: interval } : {}) });
		h[MONITOR].start();
	}
	return h[MONITOR];
}

/** The process-wide API over the one monitor. */
export function healthApi(env: Record<string, string | undefined> = process.env): ReturnType<typeof createHealthApi> {
	const h = globalThis as Holder;
	if (!h[KEY]) {
		const health = packHealth(env);
		h[KEY] = createHealthApi({ health, restarter: createRestarter({ health }), witness: sessionWitness(env), checkToken: hubTokenCheck(hubTarget(env).wolvesUrl) });
	}
	return h[KEY];
}
