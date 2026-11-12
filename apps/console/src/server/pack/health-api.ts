/**
 * THE PACK HEALTH API (work-wolfpack-LUQ7C2B). The reads never call the hub; only the restart's auth check may.
 *   GET  /api/health          snapshot of every link (unauthenticated, like the services' own /healthz: names, states, short error
 *                             codes and numbers only). Always 200 while the console runs, whatever the hub's state.
 *                             Versions, wolf names and timings are intentionally visible to the tailnet without auth (accepted).
 *   GET  /api/health/stream   SSE: the snapshot now and after every probe round (`data: <HealthSnapshot>`), `: ping` every 25 s
 *   POST /api/health/restart  {service: "hubd" | "workerd" | "wolfd@<name>"}; needs `Authorization: Bearer <device token>`.
 *                             202 {ok, service, at} | 400 invalid_request | 401 unauthorized | 429 rate_limited (+Retry-After) | 501 unsupported (no systemd) | 502 failed
 *                             200 {ok, service, lines, truncated} | 400 invalid_request | 401 | 429 | 501 unsupported (no journalctl)
 *                             | 502 journal_denied (console user not in systemd-journal) | 502 failed
 *   POST /api/health/rollback {service: "hubd" | "workerd" | "console"}; same auth; one per service per 10 min. Owner-initiated only.
 *                             202 {ok, service, at, to} | 400 | 401 | 409 no_previous / previous_is_newer | 429 (+Retry-After) | 502 failed
 *   POST /api/health/update   {}; same auth; starts wolfpack-auto-update-now.service (work-wolfpack-7eP9W3Z); one start per 5 min. Owner-initiated only.
 *                             202 {ok, at, units} | 401 | 409 no_update / running | 429 (+Retry-After) | 502 failed
 *   GET  /api/health/update   {units: components behind the latest stable, last: the unit's last run}; unauthenticated like the snapshot.
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
import { bearerOf } from "../../core/ui/hub-auth.ts";
import { createPackHealth, createRestarter, healthTargets, hubTarget, type PackHealth, type Restarter } from "./pack-health.ts";
import { createReleaseReader, createRollbacker, createUpdater, type ReleaseReader, type Rollbacker, type UpdateUnit, type Updater } from "./pack-actions.ts";
import { DEFAULT_MAIN_MANIFEST_URL, consoleVersion, createUpdatesHandler } from "./updates-api.ts";
import { createInventoryClient, type InventoryClient } from "./inventory.ts";
import { DEFAULT_MANIFEST_URL, createManifestFetcher, type InventoryEntry } from "@wolfpack/protocol";
import { createLagMonitor, machineName, readMachineChannel } from "@wolfpack/protocol/health-lag";
import { sessionWitness, type SessionWitness } from "../thread/session-witness.ts";

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
	rollbacker: Rollbacker;
	updater: Updater;
	witness: SessionWitness;
	/** Live bearer check against the hub, tried first on every restart (see RESTART AUTH). */
	checkToken: HubTokenCheck;
	now?: () => number;
}

type AuthOutcome = { ok: true } | { ok: false; busy?: undefined } | { ok: false; busy: number };

/** How long GET /api/health/update keeps its answer (it is unauthenticated). */
const UPDATE_STATE_TTL_MS = 2_000;

export function createHealthApi(d: HealthApiDeps) {
	const now = d.now ?? Date.now;
	let updateCache: { at: number; pending: boolean; body: Promise<{ units: UpdateUnit[]; last: { result: string; exitStatus: number | null; at: string | null } | null }> } | undefined;
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

	/** The shared gate of every action: the bearer header, checked as in RESTART AUTH. Returns who asked, or the error response. */
	const gateOf = async (req: Request, what: "restart" | "log read" | "rollback" | "update" | "domain change" | "subscription" | "key change"): Promise<string | Response> => {
		const token = bearerOf(req.headers.get("authorization"));
		const auth: AuthOutcome = token ? await authorise(token) : { ok: false };
		if (!auth.ok && auth.busy !== undefined) {
			return Response.json({ error: `too many ${what} attempts right now; try again shortly`, code: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(auth.busy) } });
		}
		if (!token || !auth.ok) {
			return Response.json({ error: "sign in on this device first (no recently verified device token)", code: "unauthorized" }, { status: 401, headers: NO_STORE });
		}
		return `device ${d.witness.fingerprint(token)}`;
	};
	const serviceOf = async (req: Request): Promise<unknown | Response> => {
		try {
			return ((await req.json()) as { service?: unknown } | null)?.service;
		} catch {
			return Response.json({ error: "body must be JSON {service}", code: "invalid_request" }, { status: 400, headers: NO_STORE });
		}
	};
	const failure = (out: { message: string; code: string; service: string; retryAfterS?: number }, status: number): Response =>
		Response.json({ error: out.message, code: out.code, service: out.service }, { status, headers: { ...NO_STORE, ...(out.retryAfterS ? { "Retry-After": String(out.retryAfterS) } : {}) } });

	return {
		/** The owner gate (same as restart) for other console actions: who asked, or the 401/429 response. */
		gate: gateOf,

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
			const gate = await gateOf(req, "restart");
			if (gate instanceof Response) return gate;
			const service = await serviceOf(req);
			if (service instanceof Response) return service;
			const out = await d.restarter.restart(service, gate);
			if (out.ok) return Response.json(out, { status: 202, headers: NO_STORE });
			return failure(out, out.code === "invalid_request" ? 400 : out.code === "rate_limited" ? 429 : out.code === "unsupported" ? 501 : 502);
		},

		/** POST /api/health/rollback {service}: start the root oneshot wolfpack-rollback@<service> (pack-actions.ts). Same auth as restart. */
		async rollback(req: Request): Promise<Response> {
			const gate = await gateOf(req, "rollback");
			if (gate instanceof Response) return gate;
			const service = await serviceOf(req);
			if (service instanceof Response) return service;
			const out = await d.rollbacker.rollback(service, gate);
			if (out.ok) return Response.json(out, { status: 202, headers: NO_STORE });
			return failure(out, { invalid_request: 400, no_previous: 409, previous_is_newer: 409, rate_limited: 429, failed: 502 }[out.code]);
		},

		/** POST /api/health/update: start the root oneshot wolfpack-auto-update-now (pack-actions.ts createUpdater). Same auth as restart. */
		async update(req: Request): Promise<Response> {
			const gate = await gateOf(req, "update");
			if (gate instanceof Response) return gate;
			const component = await req.json().then((b: { component?: unknown } | null) => b?.component, () => undefined); // no or non-JSON body = Update all
			const out = await d.updater.update(gate, component);
			if (out.ok) return Response.json(out, { status: 202, headers: NO_STORE });
			return failure(out, { invalid_request: 400, no_update: 409, up_to_date: 409, running: 409, failed: 502 }[out.code]);
		},

		/** GET /api/health/update: what an update would change, and how the manual unit's last run ended. */
		async updateState(): Promise<Response> {
			// Unauthenticated, so anonymous polling must not multiply the manifest read and the systemctl spawn: one computation is
			// shared while in flight and its result kept for UPDATE_STATE_TTL_MS.
			const t = now();
			if (!updateCache || (!updateCache.pending && t - updateCache.at >= UPDATE_STATE_TTL_MS)) {
				const entry: { at: number; pending: boolean; body: Promise<{ units: UpdateUnit[]; last: { result: string; exitStatus: number | null; at: string | null } | null }> } = {
					at: t,
					pending: true,
					body: Promise.all([d.updater.available(), d.updater.last()]).then(([units, last]) => ({
						units: units.map((u) => ({ component: u.component, from: u.from, to: u.to })),
						last: last ? { result: last.result, exitStatus: last.exitStatus, at: last.at } : null,
					})),
				};
				updateCache = entry;
				const done = () => { entry.pending = false; };
				entry.body.then(done, () => { done(); if (updateCache === entry) updateCache = undefined; });
			}
			return Response.json(await updateCache.body, { headers: NO_STORE });
		},
	};
}

const KEY = Symbol.for("wolfpack.console.packHealth");
const MONITOR = Symbol.for("wolfpack.console.packHealthMonitor");
const RELEASES = Symbol.for("wolfpack.console.packHealthReleases");
type Holder = { [KEY]?: ReturnType<typeof createHealthApi>; [MONITOR]?: PackHealth; [RELEASES]?: ReleaseReader };

/** The process-wide rollback-target reader: the monitor's snapshot `actions` and the rollbacker read the same one. */
const releaseReader = (): ReleaseReader => ((globalThis as Holder)[RELEASES] ??= createReleaseReader());
/** The components /api/updates says are behind the latest stable release (same reader as the sidebar notice). */
const availableUpdates = (env: Record<string, string | undefined>) => {
	const handler = createUpdatesHandler({ env });
	return async (): Promise<UpdateUnit[]> => (await handler()).components.flatMap((c) => (c.outdated === true && c.latest ? [{ component: c.component, from: c.running, to: c.latest }] : []));
};
const SYSTEMD = process.platform === "linux";

/** The process-wide monitor (started on first use; probes every WOLFPACK_HEALTH_INTERVAL_MS, default 5000). The API and the client's direct route share it. */
export function packHealth(env: Record<string, string | undefined> = process.env): PackHealth {
	const h = globalThis as Holder;
	if (!h[MONITOR]) {
		const interval = Number(env.WOLFPACK_HEALTH_INTERVAL_MS);
		const releases = releaseReader();
		// The pack inventory (work-wolfpack-ZproKxi): polled from the hub with the env hub token; this console's heartbeat rides the same client.
		const stable = createManifestFetcher({ url: env.WOLFPACK_UPDATE_MANIFEST_URL?.trim() || DEFAULT_MANIFEST_URL });
		const main = createManifestFetcher({ url: env.WOLFPACK_UPDATE_MAIN_MANIFEST_URL?.trim() || DEFAULT_MAIN_MANIFEST_URL });
		const started = Date.now();
		const lag = createLagMonitor();
		const self = (): InventoryEntry => {
			const channel = readMachineChannel();
			const version = consoleVersion();
			return { machine: machineName(), kind: "console", id: "console", ...(version ? { version } : {}), ...(channel ? { channel } : {}), uptimeS: Math.round((Date.now() - started) / 1000), lagMs: lag.sample().p99Ms };
		};
		const inv: InventoryClient = createInventoryClient({
			hubUrl: env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "") || undefined,
			token: () => env.WOLFPACK_HUB_TOKEN?.trim() || undefined,
			self,
			manifest: async (c) => (c === "main" ? main() : stable()),
		});
		inv.start();
		h[MONITOR] = createPackHealth({
			inventory: () => inv.view(),
			self,
			targets: healthTargets(env),
			...(interval >= 1000 ? { intervalMs: interval } : {}),
			actions: () => ({ systemd: SYSTEMD, rollback: SYSTEMD ? releases() : [] }),
			...(env.WOLFPACK_HEALTH_HOST_LABELS ? { hostLabels: env.WOLFPACK_HEALTH_HOST_LABELS } : {}),
		});
		h[MONITOR].start();
	}
	return h[MONITOR];
}

/** The process-wide API over the one monitor. */
export function healthApi(env: Record<string, string | undefined> = process.env): ReturnType<typeof createHealthApi> {
	const h = globalThis as Holder;
	if (!h[KEY]) {
		const health = packHealth(env);
		h[KEY] = createHealthApi({
			health,
			restarter: createRestarter({ health, systemd: SYSTEMD }),
			rollbacker: createRollbacker({ releases: releaseReader() }),
			updater: createUpdater({ available: availableUpdates(env) }),
			witness: sessionWitness(env),
			checkToken: hubTokenCheck(hubTarget(env).wolvesUrl),
		});
	}
	return h[KEY];
}
