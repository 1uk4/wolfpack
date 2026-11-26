/**
 * One update state for both update systems (work-wolfpack-nPeLT7s): the Mac app's updater events and a pack host's
 * auto-update status file (scripts/auto-update.mjs) map to the same `UpdateState`, with plain-language errors.
 * Pure: no I/O, the clock comes in through `ctx.now`. User-facing labels for the states are not here.
 */

export type UpdateTarget = "app" | "pack";
export type UpdateStage = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "updated" | "failed" | "manual" | "paused" | "stale";

export interface UpdateError {
	code: string;
	message: string;
	retryable: boolean;
	/** A background check failed (offline laptop): the sidebar stays quiet, the machine card still shows it. */
	quiet?: boolean;
}

export interface UpdateState {
	target: UpdateTarget;
	host: string;
	/** Pack only: console, hubd, workerd, wolfd. */
	component?: string;
	/** Pack only: the host unit the state comes from when it is not the component itself (workerd-wolves, wolfd@hal2). */
	unit?: string;
	state: UpdateStage;
	current: string | null;
	latest: string | null;
	/** 0-100 while downloading, 100 once downloaded, else null. */
	progress: number | null;
	/** ISO time of the last check, or null. */
	lastCheck: string | null;
	channel: "stable" | "main" | null;
	auto: "on" | "off" | "stale";
	error?: UpdateError;
}

export type AppUpdaterEvent =
	| { type: "checking" }
	| { type: "available"; version: string }
	| { type: "not-available"; version?: string }
	| { type: "progress"; percent: number }
	| { type: "downloaded"; version: string }
	| { type: "installing"; /** ms since epoch when it began; a shell window opened much later reads it as stale. */ at?: number }
	| { type: "error"; message: string; code?: string; background?: boolean };

/** The host status file (scripts/auto-update.mjs, `AutoUpdateStatus`); only the fields read here. */
export interface HostStatusFile {
	host?: string;
	enabled?: boolean;
	lastCheck?: string;
	disabledReason?: string;
	units?: Record<string, HostStatusUnit>;
}
export interface HostStatusUnit {
	component?: string;
	current?: string | null;
	target?: string | null;
	state?: string;
	code?: string;
	message?: string;
	/** ISO time the run began (scripts/auto-update.mjs). */
	startedAt?: string;
}

export interface UpdateContext {
	/** Running version (app) shown as `current` and in the "newest version" sentence. */
	version?: string | null;
	channel: "stable" | "main" | null;
	/** Clock, ms since epoch. */
	now: number;
	host?: string;
	auto?: "on" | "off";
}

/**
 * The host timer runs every 30 min (+5 randomised): two intervals without a check is stale. Same value as STALE_AFTER_MS in
 * scripts/auto-update.mjs, which ships to hosts on its own and cannot import this.
 */
export const STALE_AFTER_MS = 2 * 35 * 60_000;
const INSTALLING_STALE_MS = 5 * 60_000;
/** A host unit still `updating` this long after it started belongs to a run that died. */
const UPDATING_STALE_MS = 30 * 60_000;

const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/;
const FEED_MISSING = /Cannot find channel|HttpError: 404|\bstatus(?: code)?:? 404\b|\b404 Not Found/;

/** One plain sentence for a raw updater failure: no URLs, headers, paths or flags. The host `code` wins over the text. */
export function plainError(_source: "app" | "pack", raw: { code?: string; message?: string }, ctx: { version?: string | null } = {}): UpdateError {
	const text = raw.message ?? "";
	const code = raw.code ?? "";
	if (code === "checksum" || /checksum|sha256/i.test(text)) {
		return { code: "checksum", message: "The downloaded update did not match its checksum, so it was not installed. Try again later.", retryable: true };
	}
	if (code === "rolled-back") return { code: "rolled-back", message: "The update did not start cleanly, so the previous version was put back.", retryable: false };
	if (code === "unhealthy") return { code: "unhealthy", message: "The update installed but the service did not start healthy, so it was left as it is.", retryable: false };
	if (code === "offline" || OFFLINE.test(text)) {
		return { code: "offline", message: "Couldn't reach the update server. Check your internet connection and try again.", retryable: true };
	}
	if (code === "feed-missing" || FEED_MISSING.test(text)) {
		return { code: "feed-missing", message: `No update is published yet.${ctx.version ? ` Wolfpack ${ctx.version} is the newest version.` : ""}`, retryable: false };
	}
	return { code: "unknown", message: "The update failed. Try again later, and if it keeps failing check the logs.", retryable: true };
}

/** The one place the in-flight stage labels live (owner-approved wording); null for stages that show nothing. */
export function stageLabel(s: Pick<UpdateState, "state" | "progress">): string | null {
	switch (s.state) {
		case "checking":
			return "Checking for updates…";
		case "downloading":
			return `Downloading ${s.progress ?? 0}%`;
		case "ready":
			return "Ready, restart to update";
		case "installing":
			return "Installing…";
		case "failed":
			return "Update failed";
		default:
			return null;
	}
}

/** The next app state after one updater event. `prev` is undefined before the first event. */
export function mapAppEvent(prev: UpdateState | undefined, e: AppUpdaterEvent, ctx: UpdateContext): UpdateState {
	const { error: _drop, ...p } = prev ?? ({} as Partial<UpdateState>);
	const base: UpdateState = {
		target: "app",
		host: ctx.host ?? "this Mac",
		state: "idle",
		current: ctx.version ?? null,
		latest: null,
		progress: null,
		lastCheck: null,
		channel: ctx.channel,
		auto: ctx.auto ?? "on",
		...p,
	};
	switch (e.type) {
		case "checking":
			return { ...base, state: "checking" };
		case "available":
			return { ...base, state: "available", latest: e.version, progress: null };
		case "not-available":
			return { ...base, state: "idle", latest: e.version ?? ctx.version ?? base.current, progress: null, lastCheck: new Date(ctx.now).toISOString() };
		case "progress":
			return { ...base, state: "downloading", progress: Math.min(100, Math.max(0, Math.round(e.percent))) };
		case "downloaded":
			return { ...base, state: "ready", latest: e.version, progress: 100 };
		case "installing":
			// A successful install quits the app, so an old "installing" means it never finished.
			return e.at != null && ctx.now - e.at > INSTALLING_STALE_MS ? { ...base, state: "idle", progress: null } : { ...base, state: "installing" };
		case "error":
			return { ...base, state: "failed", progress: null, error: { ...plainError("app", { code: e.code, message: e.message }, ctx), ...(e.background ? { quiet: true } : {}) } };
	}
}

/** Worst first: a component with several units (workerd, wolfd@*) shows the unit that needs a look. */
const RANK = ["failed", "updating", "disabled", "updated", "idle"];

/** One pack component's state from the host status file, or undefined when the file names no unit of it. */
export function mapHostStatus(file: HostStatusFile, component: string, ctx: UpdateContext): UpdateState | undefined {
	const units = Object.entries(file.units ?? {}).filter(([, u]) => u?.component === component && RANK.includes(u.state ?? ""));
	if (!units.length) return undefined;
	const [id, u] = units.sort(([, a], [, b]) => RANK.indexOf(a.state!) - RANK.indexOf(b.state!))[0]!;
	const killSwitch = file.disabledReason?.startsWith("kill switch") === true;
	// enabled:false is the timer being off (button/off mode); only the kill switch is a pause.
	const manual = file.enabled === false && !killSwitch;
	const checked = Date.parse(file.lastCheck ?? "");
	const stale = !manual && Number.isFinite(checked) && ctx.now - checked > STALE_AFTER_MS;
	const current = u.current ?? null;
	const latest = u.target ?? null;
	const started = Date.parse(u.startedAt ?? "");
	const diedMidRun = u.state === "updating" && Number.isFinite(started) && ctx.now - started > UPDATING_STALE_MS;
	let state: UpdateStage;
	switch (u.state) {
		case "failed":
			state = "failed";
			break;
		case "updating":
			state = diedMidRun ? "failed" : "installing";
			break;
		case "disabled":
			state = manual ? "manual" : "paused";
			break;
		default:
			state = manual ? "manual" : stale ? "stale" : u.state === "idle" && latest && latest !== current ? "available" : u.state === "updated" ? "updated" : "idle";
	}
	return {
		target: "pack",
		host: file.host ?? "unknown",
		component,
		...(id !== component ? { unit: id } : {}),
		state,
		current,
		latest,
		progress: null,
		lastCheck: file.lastCheck ?? null,
		channel: ctx.channel,
		auto: stale ? "stale" : manual || killSwitch ? "off" : "on",
		...(state === "failed" ? { error: diedMidRun ? { code: "interrupted", message: "The last update stopped before it finished.", retryable: true } : plainError("pack", { code: u.code, message: u.message }, ctx) } : {}),
	};
}
