/**
 * PACK HEALTH MONITOR (work-wolfpack-LUQ7C2B): the console server probes the pack's links itself, so the panel keeps working on every
 * device while the hub is down or frozen. No hub API is ever called here: hubd is probed only on its unauthenticated /healthz.
 *
 * Links:
 *   hubd                 GET <hub>/healthz (expectService hubd)
 *   workerd units        GET <workerd>/healthz (expectService workerd); its `wolves` list is how the console learns the wolves
 *   wolfd@<name>         the state its workerd reports (wolfd listens on a unix socket only workerd may dial), or a direct /healthz
 *                        probe when WOLFPACK_HEALTH_WOLVES names a URL for it (e.g. a TCP wolfd in dev)
 *
 * Status per link: ok | degraded | recovering | down | frozen | restarting | unknown.
 *   frozen      no answer within the probe timeout (a hung event loop), as opposed to down (refused, HTTP 5xx, wrong service)
 *   recovering  answering fast but still graded degraded right after an outage/restart: the service's lag is a ~20 s rolling window,
 *               so one long stall keeps it degraded for a while after it is fine again
 *   restarting  a restart was issued from here and the new process has not answered yet. Ends on the first answer from a process
 *               younger than the restart (uptimeS), or after RESTART_DEADLINE_MS. A wolf read off workerd has no uptime and its
 *               "online" can still be the old process, so it ends only when workerd's restart count for it went up, or a
 *               not-online state was seen after the restart and it is online again, or at the deadline.
 *   unknown     a service that answered but with no health body: an older build from before /healthz (no_healthz: 401/403/404,
 *               a 200 that is not a health body, or a body without `service`). It runs, but is not verified healthy, so lastOkAt
 *               stays. Or a wolf whose state cannot be told: its workerd is not answering (error workerd_unavailable; kept however
 *               long that lasts), or its workerd answers but no longer lists it (not_reported; dropped after WOLF_FORGET_MS of that).
 * `error` is a short code, never raw text (the snapshot is unauthenticated): timeout | refused | http_<status> | wrong_service |
 * no_healthz | unreachable for probes; slow | reports_not_ok when degraded; wolf_<state> | workerd_unavailable | not_reported for
 * wolves. Raw errors go to
 * the server log only.
 * Each status change is appended to the link's `history` (last HISTORY_MAX), so the UI can say "restarting… back".
 *
 * DIRECT PATH (work-wolfpack-Fy45EOA): the link `workerd-direct` (kind direct) is the console's fallback to the workerd on THIS machine.
 * It is probed on the authenticated path (GET <url>/direct/v1/wolves with the local token from its 0600 file; no token file: down,
 * no_token), and the wolves it lists are the ones the direct path may serve. The snapshot's `route` says where the console's client
 * goes: "hub" normally; "direct" after SWITCH_ROUNDS consecutive rounds in which hubd does not answer (down, frozen, refused, timeout)
 * while the direct link answers; back to "hub" after SWITCH_ROUNDS consecutive rounds in which hubd answers (symmetric, so one slow or
 * failed probe never flips it either way). A live check (direct-path.ts) is one round like any other. A hub 401 never moves it: /healthz is unauthenticated.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeHealth, DEGRADED_RESPONSE_MS, PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, type ProbeResult } from "@wolfpack/protocol";

export type LinkKind = "hubd" | "workerd" | "wolfd" | "direct";
/** Where the console's client sends wolf traffic: through the hub, or straight to the local workerd while the hub is unreachable. */
export type Route = "hub" | "direct";

/** The link id of the direct path in the snapshot. */
export const DIRECT_LINK_ID = "workerd-direct";
/** Consecutive hubd rounds (failing, or answering) before the route switches to direct, or back to hub. */
export const SWITCH_ROUNDS = 2;
/** The header workerd's /direct/v1 checks the local token in (packages/workerd/src/direct-token.ts DIRECT_TOKEN_HEADER). */
export const DIRECT_TOKEN_HEADER = "x-wolfpack-direct-token";

export interface DirectTarget {
	/** The local workerd's origin (loopback only). */
	url: string;
	/** workerd's direct-token file (mode 0600). */
	tokenFile: string;
}

/** The local token, or undefined when the file is missing, unreadable or empty. Read on every use (workerd may create it later). */
export function readDirectToken(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The direct path from the environment, or undefined when it is off (opt-in: only a console on the same machine as a workerd has one):
 *   WOLFPACK_WORKERD_DIRECT_URL         the local workerd, e.g. http://127.0.0.1:7141 (unset: off). Must be http on loopback: the token
 *                                       never leaves the machine.
 *   WOLFPACK_WORKERD_DIRECT_TOKEN_FILE  default <WORKERD_CONFIG_DIR or ~/.wolfpack/workerd>/direct-token (workerd creates it)
 */
export function directTarget(env: Record<string, string | undefined> = process.env): DirectTarget | undefined {
	const raw = env.WOLFPACK_WORKERD_DIRECT_URL?.trim();
	if (!raw) return undefined;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		console.warn("console: WOLFPACK_WORKERD_DIRECT_URL is not a URL; the direct path is off");
		return undefined;
	}
	if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
		console.warn("console: WOLFPACK_WORKERD_DIRECT_URL must be http on loopback (127.0.0.1, ::1, localhost); the direct path is off");
		return undefined;
	}
	const tokenFile = env.WOLFPACK_WORKERD_DIRECT_TOKEN_FILE?.trim() || join(env.WORKERD_CONFIG_DIR?.trim() || join(homedir(), ".wolfpack", "workerd"), "direct-token");
	return { url: url.origin, tokenFile };
}
export type LinkStatus = "ok" | "degraded" | "recovering" | "down" | "frozen" | "restarting" | "unknown";

export interface LinkHistoryEntry {
	status: LinkStatus;
	at: string;
}

export interface LinkSnapshot {
	/** The systemd unit name without `.service` ("hubd", "workerd", "wolfd@hal"); also the id `POST /api/health/restart` takes. */
	id: string;
	kind: LinkKind;
	status: LinkStatus;
	/** Last probe's wall time (ms); null when the link was not probed directly (a wolf read off its workerd) or never probed. */
	responseMs: number | null;
	/** Event-loop p99 the service reported (ms), when it answered. */
	lagMs: number | null;
	/** Last time the link answered (ok, degraded or recovering). Kept across outages: "last OK 3 min ago". */
	lastOkAt: string | null;
	lastCheckedAt: string | null;
	/** Why it is not ok (probe error, or the workerd-reported wolf state). */
	error: string | null;
	version: string | null;
	uptimeS: number | null;
	/** Wolves only: the workerd link the state was read from. */
	via?: string;
	history: LinkHistoryEntry[];
	/** The last restart issued from this console, if any. */
	lastRestart: { at: string; ok: boolean } | null;
	restartable: boolean;
}

export interface HealthSnapshot {
	checkedAt: string | null;
	intervalMs: number;
	/** Where the console's client goes right now (see DIRECT PATH). */
	route: Route;
	links: LinkSnapshot[];
}

export interface HealthTargets {
	hub: string;
	workerds: { id: string; url: string }[];
	/** Wolves with a direct /healthz URL (optional). */
	wolves: { name: string; url: string }[];
	/** The local workerd's direct console path (absent: no `workerd-direct` link, the route stays hub). */
	direct?: DirectTarget;
}

export const HISTORY_MAX = 20;
export const RESTART_DEADLINE_MS = 120_000;
/** A wolf its (answering) workerd has not reported for this long is dropped from the snapshot. */
export const WOLF_FORGET_MS = 10 * 60_000;
/** At most this many wolves are read from one workerd's /healthz (the rest are ignored). */
export const MAX_WOLVES_PER_WORKERD = 64;
const UNIT_RE = /^[a-z0-9][a-z0-9-]*$/;
const WOLF_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKERD_UNIT_RE = /^workerd(-[a-z0-9]+)*$/;

const healthzUrl = (u: string): string => {
	const url = new URL(u);
	if (url.pathname === "/" || url.pathname === "") url.pathname = "/healthz";
	return url.toString();
};

/** `id=url,id=url` (ids filtered by `ok`). */
function pairs(raw: string | undefined, ok: (id: string) => boolean, what: string): { id: string; url: string }[] {
	const out: { id: string; url: string }[] = [];
	for (const part of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
		const i = part.indexOf("=");
		const id = i > 0 ? part.slice(0, i).trim() : "";
		if (!ok(id)) {
			console.warn(`console: ignoring ${what} entry "${part}" (want <name>=<url>)`);
			continue;
		}
		try {
			out.push({ id, url: healthzUrl(part.slice(i + 1).trim()) });
		} catch {
			console.warn(`console: ignoring ${what} entry "${part}" (bad URL)`);
		}
	}
	return out;
}

/**
 * The ONE hub the console checks, for both the monitor and the restart's live token check (so they can never disagree about which
 * hub is up): the origin of WOLFPACK_HEALTH_HUB_URL, else the origin of WOLFPACK_HUB_URL, else http://127.0.0.1:3150.
 *   healthz    WOLFPACK_HEALTH_HUB_URL as given (a bare origin gets /healthz), else <origin>/healthz
 *   wolvesUrl  <origin><path prefix of WOLFPACK_HUB_URL>/v1/wolves: the URL the console's hub client (HttpConsoleClient) builds for
 *              listWolves from WOLFPACK_HUB_URL (base without trailing slashes + route path), moved onto the checked origin
 */
export function hubTarget(env: Record<string, string | undefined> = process.env): { origin: string; healthz: string; wolvesUrl: string } {
	let base: URL | undefined;
	const raw = env.WOLFPACK_HUB_URL?.trim();
	if (raw) {
		try {
			base = new URL(raw);
		} catch {
			console.warn("console: WOLFPACK_HUB_URL is not a URL; checking hubd at http://127.0.0.1:3150");
		}
	}
	let healthz = `${base?.origin ?? "http://127.0.0.1:3150"}/healthz`;
	const override = env.WOLFPACK_HEALTH_HUB_URL?.trim();
	if (override) {
		try {
			healthz = healthzUrl(override);
		} catch {
			console.warn("console: WOLFPACK_HEALTH_HUB_URL is not a URL; ignoring it");
		}
	}
	const origin = new URL(healthz).origin;
	const prefix = (base?.pathname ?? "").replace(/\/+$/, "");
	return { origin, healthz, wolvesUrl: `${origin}${prefix}/v1/wolves` };
}

/**
 * The probe targets from the environment:
 *   hub                       hubTarget(env).healthz (WOLFPACK_HEALTH_HUB_URL, else the origin of WOLFPACK_HUB_URL, else http://127.0.0.1:3150)
 *   WOLFPACK_HEALTH_WORKERDS  `<unit>=<url>,...` (unit = workerd or workerd-<x>); default workerd=http://127.0.0.1:7141 (workerd's own default port)
 *   WOLFPACK_HEALTH_WOLVES    `<name>=<url>,...` wolfd /healthz URLs to probe directly (optional; normally the wolves come from workerd)
 */
export function healthTargets(env: Record<string, string | undefined> = process.env): HealthTargets {
	const workerds = pairs(env.WOLFPACK_HEALTH_WORKERDS?.trim() || "workerd=http://127.0.0.1:7141", (id) => WORKERD_UNIT_RE.test(id), "WOLFPACK_HEALTH_WORKERDS");
	const wolves = pairs(env.WOLFPACK_HEALTH_WOLVES, (id) => WOLF_RE.test(id), "WOLFPACK_HEALTH_WOLVES").map(({ id, url }) => ({ name: id, url }));
	const direct = directTarget(env);
	return { hub: hubTarget(env).healthz, workerds, wolves, ...(direct ? { direct } : {}) };
}

interface LinkState {
	id: string;
	kind: LinkKind;
	url?: string;
	via?: string;
	status: LinkStatus;
	responseMs: number | null;
	lagMs: number | null;
	lastOkAt: string | null;
	lastCheckedAt: string | null;
	error: string | null;
	version: string | null;
	uptimeS: number | null;
	history: LinkHistoryEntry[];
	restartAt: number | null;
	lastRestart: { at: string; ok: boolean } | null;
	/** Wolves read off workerd: the last restart count it reported, and the count when a restart was issued from here. */
	restarts: number | null;
	restartsAtMark: number | null;
	/** A not-online observation was seen since the restart was issued (so the next online is the new process). */
	sawOutSinceRestart: boolean;
	/** Wolves read off workerd: last time any workerd reported this wolf (ms). */
	lastReportedAt: number;
}

/** One observation of a link, before the restart/recovery rules. */
interface Observation {
	answered: boolean;
	graded: "ok" | "degraded" | "down" | "frozen" | "restarting" | "unknown";
	responseMs: number | null;
	lagMs: number | null;
	error: string | null;
	version: string | null;
	uptimeS: number | null;
	/** Wolves read off workerd: the supervisor's restart count for this wolf (ChildStatus.restarts). */
	restarts?: number;
	/** The probe's raw error text: server log only, never in the snapshot. */
	rawError?: string;
}

/**
 * The snapshot is unauthenticated, so a probe failure is a short code, never the raw error text (which can carry addresses, paths
 * or library messages): timeout | refused | http_<status> | wrong_service | no_healthz | unreachable. The raw text is logged
 * server-side when a link's code changes.
 *   no_healthz     an answer with no health body, as an older build gives: 401/403/404 on /healthz (hubd had it behind auth), a 2xx
 *                  that is not a JSON object, or a body with no `service`. wrong_service is kept for a health body naming another
 *                  service (something else on that port).
 */
function probeErrorCode(r: ProbeResult): string {
	const raw = r.error ?? "";
	if (raw.startsWith("no answer within ")) return "timeout";
	const http = /^HTTP (\d{3})$/.exec(raw);
	if (http) return http[1] === "401" || http[1] === "403" || http[1] === "404" ? "no_healthz" : `http_${http[1]}`;
	if (raw === "wrong service") return typeof r.body?.service === "string" ? "wrong_service" : "no_healthz";
	if (raw === "unparseable health body") return "no_healthz";
	if (raw === "ECONNREFUSED") return "refused";
	return "unreachable";
}

const fromProbe = (r: ProbeResult, timeoutMs: number): Observation => {
	const code = r.error !== undefined ? probeErrorCode(r) : null;
	return {
		answered: r.status !== "down",
		graded: code === "no_healthz" ? "unknown" : r.status === "down" ? (r.body === undefined && r.responseMs >= timeoutMs ? "frozen" : "down") : r.status,
	responseMs: r.responseMs,
	lagMs: r.lagMs ?? null,
		error: code ?? (r.status === "degraded" ? (r.body?.ok === false ? "reports_not_ok" : "slow") : null),
		version: typeof r.body?.version === "string" ? r.body.version : null,
		uptimeS: typeof r.body?.uptimeS === "number" ? r.body.uptimeS : null,
		...(r.error !== undefined ? { rawError: r.error } : {}),
	};
};

const WOLF_STATES = new Set(["online", "starting", "restarting", "failed", "stopped"]);

/** A wolf's state as its workerd's supervisor reports it (ChildState, restarts). Error codes: wolf_<state> | wolf_unknown. */
const fromWorkerdWolf = (w: { state?: unknown; restarts?: unknown }): Observation => {
	const s = typeof w.state === "string" && WOLF_STATES.has(w.state) ? w.state : "unknown";
	const graded = s === "online" ? "ok" : s === "starting" || s === "restarting" ? "restarting" : s === "failed" || s === "stopped" ? "down" : "unknown";
	return {
		answered: graded === "ok",
		graded,
		responseMs: null,
		lagMs: null,
		error: graded === "ok" ? null : `wolf_${s}`,
		version: null,
		uptimeS: null,
		...(typeof w.restarts === "number" ? { restarts: w.restarts } : {}),
		...(s === "unknown" && w.state !== undefined ? { rawError: `workerd reports state ${JSON.stringify(String(w.state).slice(0, 80))}` } : {}),
	};
};

export interface PackHealthOptions {
	targets: HealthTargets;
	intervalMs?: number;
	timeoutMs?: number;
	now?: () => number;
	fetch?: typeof fetch;
	/** Where raw probe errors go (server log only). Default console.warn. */
	log?: (m: string) => void;
}

export interface PackHealth {
	/** Probe every link once (concurrent calls share one round). */
	tick(): Promise<HealthSnapshot>;
	snapshot(): HealthSnapshot;
	/** Called after every round; returns the unsubscribe. */
	subscribe(fn: (s: HealthSnapshot) => void): () => void;
	/** Unit ids a restart may target right now (hubd, the workerd units, wolfd@<known wolf>). */
	restartable(): Set<string>;
	/** Record a restart issued for `id` (the link shows "restarting" until the new process answers). */
	markRestart(id: string, ok: boolean): void;
	/** Where the console's client goes right now (see DIRECT PATH). */
	route(): Route;
	/** The wolves the direct link listed in its last answering round (the only ones the direct path may serve). */
	localWolves(): ReadonlySet<string>;
	start(): void;
	stop(): void;
}

export function createPackHealth(o: PackHealthOptions): PackHealth {
	const intervalMs = o.intervalMs ?? 5000;
	const timeoutMs = o.timeoutMs ?? 3000;
	const now = o.now ?? Date.now;
	const log = o.log ?? ((m: string) => console.warn(m));
	const links = new Map<string, LinkState>();
	const listeners = new Set<(s: HealthSnapshot) => void>();
	let checkedAt: string | null = null;
	let route: Route = "hub";
	let hubOkRounds = 0;
	let hubFailRounds = 0;
	let localWolves: ReadonlySet<string> = new Set();
	let round: Promise<HealthSnapshot> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const link = (id: string, kind: LinkKind, extra: { url?: string; via?: string } = {}): LinkState => {
		let l = links.get(id);
		if (!l) {
			l = {
				id, kind, status: "unknown", responseMs: null, lagMs: null, lastOkAt: null, lastCheckedAt: null, error: null, version: null, uptimeS: null,
				history: [], restartAt: null, lastRestart: null, restarts: null, restartsAtMark: null, sawOutSinceRestart: false, lastReportedAt: now(),
			};
			links.set(id, l);
		}
		Object.assign(l, extra);
		return l;
	};
	link("hubd", "hubd", { url: o.targets.hub });
	for (const w of o.targets.workerds) link(w.id, "workerd", { url: w.url });
	for (const w of o.targets.wolves) link(`wolfd@${w.name}`, "wolfd", { url: w.url });
	const direct = o.targets.direct;
	if (direct) link(DIRECT_LINK_ID, "direct"); // no `url`: probed on its authenticated path below, not as a /healthz

	const setStatus = (l: LinkState, s: LinkStatus, t: number) => {
		if (l.status === s && l.history.length > 0) return;
		l.status = s;
		l.history.push({ status: s, at: new Date(t).toISOString() });
		if (l.history.length > HISTORY_MAX) l.history.splice(0, l.history.length - HISTORY_MAX);
	};

	const apply = (l: LinkState, ob: Observation, t: number) => {
		const at = new Date(t).toISOString();
		if (ob.error !== l.error && ob.rawError) log(`console: health ${l.id}: ${ob.error} (${ob.rawError})`);
		Object.assign(l, { responseMs: ob.responseMs, lagMs: ob.lagMs, error: ob.error, version: ob.version, uptimeS: ob.uptimeS, lastCheckedAt: at });
		const prevRestarts = l.restarts;
		if (ob.restarts !== undefined) l.restarts = ob.restarts;
		if (ob.answered || ob.graded === "degraded") l.lastOkAt = at;
		const prev = l.status;
		if (l.restartAt !== null) {
			const since = t - l.restartAt;
			// With an uptime the new process is the one younger than the restart. Without one (a wolf read off workerd, whose
			// "online" may still be the old process before systemd replaced it) it is new once workerd's restart count went up,
			// or once a not-online state was seen since the restart; otherwise "restarting" holds until the deadline.
			const base = l.restartsAtMark ?? prevRestarts;
			const fresh =
				ob.answered &&
				(ob.uptimeS !== null ? ob.uptimeS * 1000 <= since + 2000 : l.sawOutSinceRestart || (ob.restarts !== undefined && base !== null && ob.restarts > base));
			if (!ob.answered) l.sawOutSinceRestart = true;
			if (!fresh && since < RESTART_DEADLINE_MS) return setStatus(l, "restarting", t);
			l.restartAt = null;
			l.restartsAtMark = null;
			l.sawOutSinceRestart = false;
		}
		const wasOut = prev === "down" || prev === "frozen" || prev === "restarting" || prev === "recovering";
		if (ob.graded === "degraded" && wasOut && (ob.responseMs === null || ob.responseMs < DEGRADED_RESPONSE_MS)) return setStatus(l, "recovering", t);
		setStatus(l, ob.graded, t);
	};

	const snapshot = (): HealthSnapshot => {
		const can = restartable();
		return {
			checkedAt,
			intervalMs,
			route,
			links: [...links.values()].map((l) => ({
				id: l.id,
				kind: l.kind,
				status: l.status,
				responseMs: l.responseMs,
				lagMs: l.lagMs,
				lastOkAt: l.lastOkAt,
				lastCheckedAt: l.lastCheckedAt,
				error: l.error,
				version: l.version,
				uptimeS: l.uptimeS,
				...(l.via ? { via: l.via } : {}),
				history: l.history.map((h) => ({ ...h })),
				lastRestart: l.lastRestart,
				restartable: can.has(l.id),
			})),
		};
	};

	const restartable = (): Set<string> => new Set([...links.values()].filter((l) => l.kind === "hubd" || l.kind === "workerd" || (l.kind === "wolfd" && UNIT_RE.test(l.id.slice("wolfd@".length)))).map((l) => l.id));

	const probe = (url: string, service: string) => probeHealth(url, { timeoutMs, expectService: service, ...(o.fetch ? { fetch: o.fetch } : {}) });

	/** The direct path probed as the console uses it: the local token on GET /direct/v1/wolves. */
	const probeDirect = async (d: DirectTarget): Promise<{ ob: Observation; wolves: string[] }> => {
		const token = readDirectToken(d.tokenFile);
		if (!token) return { ob: { answered: false, graded: "down", responseMs: null, lagMs: null, error: "no_token", version: null, uptimeS: null, rawError: `no direct token in ${d.tokenFile}` }, wolves: [] };
		const r = await probeHealth(`${d.url}/direct/v1/wolves`, { timeoutMs, headers: { [DIRECT_TOKEN_HEADER]: token, [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION) }, ...(o.fetch ? { fetch: o.fetch } : {}) });
		const listed = r.status !== "down" && Array.isArray(r.body?.wolves) ? (r.body.wolves as unknown[]) : [];
		const wolves = listed.map((w) => (w as { name?: unknown })?.name).filter((n): n is string => typeof n === "string" && WOLF_RE.test(n)).slice(0, MAX_WOLVES_PER_WORKERD);
		return { ob: fromProbe(r, timeoutMs), wolves };
	};

	const runRound = async (): Promise<HealthSnapshot> => {
		const direct = [...links.values()].filter((l) => l.url);
		const [results, directResult] = await Promise.all([
			Promise.all(direct.map(async (l) => [l, await probe(l.url!, l.kind)] as const)),
			o.targets.direct ? probeDirect(o.targets.direct) : Promise.resolve(undefined),
		]);
		const t = now();
		if (directResult) {
			apply(link(DIRECT_LINK_ID, "direct"), directResult.ob, t);
			if (directResult.ob.answered) localWolves = new Set(directResult.wolves);
		}
		// The route (see DIRECT PATH). hubd "answering" = its /healthz probe was not down (ok, degraded or recovering).
		const hubAnswered = results.some(([l, r]) => l.kind === "hubd" && r.status !== "down");
		if (route === "hub") {
			if (hubAnswered) hubFailRounds = 0;
			else if (++hubFailRounds >= SWITCH_ROUNDS && directResult?.ob.answered) {
				route = "direct";
				hubOkRounds = 0;
				hubFailRounds = 0;
				log("console: hub unreachable: chat now goes straight to the local workerd");
			}
		} else if (!hubAnswered) hubOkRounds = 0;
		else if (++hubOkRounds >= SWITCH_ROUNDS) {
			route = "hub";
			hubOkRounds = 0;
			log("console: hub back: chat goes through the hub again");
		}
		const reported = new Set<string>();
		const answeringWorkerds = new Set<string>();
		for (const [l, r] of results) {
			apply(l, fromProbe(r, timeoutMs), t);
			if (l.kind !== "workerd") continue;
			if (r.status !== "down") answeringWorkerds.add(l.id);
			const wolves = r.status !== "down" && Array.isArray(r.body?.wolves) ? (r.body.wolves as unknown[]) : [];
			let taken = 0;
			for (const w of wolves) {
				const name = (w as { name?: unknown })?.name;
				if (typeof name !== "string" || !WOLF_RE.test(name)) continue;
				if (++taken > MAX_WOLVES_PER_WORKERD) {
					log(`console: health: ${l.id} reports more than ${MAX_WOLVES_PER_WORKERD} wolves; ignoring the rest`);
					break;
				}
				const wl = link(`wolfd@${name}`, "wolfd", { via: l.id });
				if (wl.url) continue; // probed directly
				reported.add(wl.id);
				wl.lastReportedAt = t;
				apply(wl, fromWorkerdWolf(w as { state?: unknown; restarts?: unknown }), t);
			}
		}
		// Wolves seen before that their workerd did not report this round. Workerd not answering (down, frozen): unknown,
		// workerd_unavailable, never dropped, and the forget clock restarts (a wolf is not forgotten for its workerd's outage).
		// Workerd answering without it (the wolf left): unknown, not_reported, dropped after WOLF_FORGET_MS of that, so the map
		// stays bounded by what the workerds report.
		for (const l of [...links.values()]) {
			if (l.kind !== "wolfd" || l.url || reported.has(l.id)) continue;
			if (l.via && !answeringWorkerds.has(l.via)) {
				l.lastReportedAt = t;
				apply(l, { answered: false, graded: "unknown", responseMs: null, lagMs: null, error: "workerd_unavailable", version: null, uptimeS: null }, t);
				continue;
			}
			if (t - l.lastReportedAt > WOLF_FORGET_MS) {
				links.delete(l.id);
				continue;
			}
			apply(l, { answered: false, graded: "unknown", responseMs: null, lagMs: null, error: "not_reported", version: null, uptimeS: null }, t);
		}
		checkedAt = new Date(t).toISOString();
		const s = snapshot();
		for (const fn of listeners) {
			try {
				fn(s);
			} catch {
				/* a broken listener never stops the monitor */
			}
		}
		return s;
	};

	return {
		tick() {
			round ??= runRound().finally(() => {
				round = undefined;
			});
			return round;
		},
		snapshot,
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		restartable,
		route: () => route,
		localWolves: () => localWolves,
		markRestart(id, ok) {
			const l = links.get(id);
			if (!l) return;
			const t = now();
			l.lastRestart = { at: new Date(t).toISOString(), ok };
			if (ok) {
				l.restartAt = t;
				l.restartsAtMark = l.restarts;
				l.sawOutSinceRestart = false;
				setStatus(l, "restarting", t);
			}
		},
		start() {
			if (timer) return;
			void this.tick();
			timer = setInterval(() => void this.tick(), intervalMs);
			timer.unref?.();
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
		},
	};
}

// ─── Restart ───────────────────────────────────────────────────────────────

/** Runs one argv (no shell). Resolves with the exit code; never rejects. */
export type CommandRunner = (file: string, args: string[]) => Promise<{ code: number; stderr: string }>;

export const execRunner: CommandRunner = (file, args) =>
	new Promise((resolve) => {
		execFile(file, args, { timeout: 15_000, shell: false }, (err, _stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
			resolve({ code, stderr: String(stderr ?? "").slice(0, 500) });
		});
	});

export type RestartOutcome =
	| { ok: true; service: string; at: string }
	| { ok: false; service: string; code: "invalid_request" | "rate_limited" | "failed"; message: string; retryAfterS?: number };

export interface Restarter {
	restart(service: unknown, by: string): Promise<RestartOutcome>;
}

/**
 * Restarts a pack unit with `systemctl --no-ask-password --no-block restart <unit>.service`, authorised by the polkit rule
 * deploy/console/50-console-restart.rules (restart only, these units only). `service` must be one of `health.restartable()`:
 * anything else (unknown names, `hubd; rm`, `wolfd@../x`) is rejected before any command runs. One restart per service per
 * `minIntervalMs` (default 60 s). Every attempt is logged with who asked.
 */
export function createRestarter(o: { health: PackHealth; run?: CommandRunner; now?: () => number; minIntervalMs?: number; log?: (m: string) => void }): Restarter {
	const run = o.run ?? execRunner;
	const now = o.now ?? Date.now;
	const minInterval = o.minIntervalMs ?? 60_000;
	const log = o.log ?? ((m: string) => console.log(m));
	const last = new Map<string, number>();
	return {
		async restart(service, by) {
			const name = typeof service === "string" ? service : "";
			if (!o.health.restartable().has(name)) {
				log(`console: health restart REFUSED (unknown service ${JSON.stringify(String(service).slice(0, 80))}) by ${by}`);
				return { ok: false, service: name, code: "invalid_request", message: "unknown service" };
			}
			const t = now();
			const prev = last.get(name);
			if (prev !== undefined && t - prev < minInterval) {
				const retryAfterS = Math.ceil((minInterval - (t - prev)) / 1000);
				log(`console: health restart ${name} RATE-LIMITED by ${by}`);
				return { ok: false, service: name, code: "rate_limited", message: `restarted less than ${Math.round(minInterval / 1000)}s ago`, retryAfterS };
			}
			last.set(name, t);
			const r = await run("systemctl", ["--no-ask-password", "--no-block", "restart", `${name}.service`]);
			o.health.markRestart(name, r.code === 0);
			log(`console: health restart ${name} by ${by}: ${r.code === 0 ? "ok" : `FAILED (exit ${r.code}) ${r.stderr.trim()}`}`);
			return r.code === 0 ? { ok: true, service: name, at: new Date(t).toISOString() } : { ok: false, service: name, code: "failed", message: `systemctl exited ${r.code}` };
		},
	};
}
