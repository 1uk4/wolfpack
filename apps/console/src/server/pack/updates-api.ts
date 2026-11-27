/**
 * GET /api/updates: is any pack component behind the latest stable release?
 *
 * Running versions come from what the console can see on its own, never through the hub:
 *   console  its own VERSION stamp (scripts/release-version.mjs; see `consoleVersion`)
 *   hubd     GET <WOLFPACK_HUB_URL>/healthz `version`   (hub down = unknown, the rest still answers)
 *   workerd  GET <WOLFPACK_API_URL>/healthz `version`   (unset, e.g. relay mode = unknown)
 *   wolfd    unknown for now: workerd's /healthz lists wolves without versions
 * Latest versions come from the stable manifest (@wolfpack/protocol createManifestFetcher), cached there.
 *
 * Env: WOLFPACK_UPDATE_MANIFEST_URL overrides the manifest URL (a local file server for testing); "off" disables the check.
 * Applying updates is the host's own job (work-wolfpack-qrU6cCO, scripts/auto-update.mjs on a timer). Its status file
 * (WOLFPACK_AUTO_UPDATE_STATUS, default /var/lib/wolfpack-auto-update/status.json, the sfo-01 path) is read on every request and shown
 * per component as `updateStatus`; with no file (e.g. a Mac console) the field is absent and `updateStep` names the manual step.
 * The Mac's own updater status is shown by `pnpm stack status` (scripts/stack.mjs), not here: the console cannot read the Mac's files.
 * Auth: not gated (proxy.ts only maps the cookie to a bearer; the route checks none); fine, it returns version info and public release URLs only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_MANIFEST_URL, checkUpdates, createManifestFetcher, probeHealth, type ManifestResult, type UpdateRow } from "@wolfpack/protocol";
import { stampedVersion, subscriptionFile } from "@wolfpack/protocol/health-lag";
import { failedLine, mapHostStatus, plainError, STALE_AFTER_MS as HOST_STALE_AFTER_MS, type UpdateState } from "@wolfpack/protocol/update-state";
import { macAutoUpdateDir } from "./updater-paths.ts";
import { readSubscription } from "./subscription-api.ts";

export type HostUnitState = "idle" | "updating" | "updated" | "failed" | "disabled";

/** The host updater's view of one component (from its status file; scripts/auto-update.mjs). */
export interface UpdateStatus {
	state: HostUnitState;
	host: string;
	/** When the updater last ran (ISO). */
	lastCheck: string;
	/** The unit the state comes from when the component has several (workerd-wolves, wolfd@<name>). */
	unit?: string;
	/** Error code when failed (unhealthy, checksum, rolled-back, ...). */
	code?: string;
	message?: string;
	/** When the update started (updating) or finished (updated, failed). */
	at?: string;
	/** true when `lastCheck` is older than STALE_AFTER_MS: the timer is not running, or every run finds the lock held. Never set with `manual`. */
	stale?: true;
	/** true when auto-update is switched off on the host (status file `enabled:false` with no kill-switch reason): updates are manual, so a quiet timer is expected. */
	manual?: true;
}

export interface UpdateComponent extends UpdateRow {
	/** What happens next for this component (shown with the notice). */
	updateStep: string;
	/** Present when the host's auto-update status file is readable. */
	updateStatus?: UpdateStatus;
	/** The same state in the shape shared with the Mac app (packages/protocol update-state.ts). Present with `updateStatus`. */
	updateState?: UpdateState;
}

export interface UpdatesBody {
	checkedAt: string;
	/** true when at least one component is known to be behind. */
	outdated: boolean;
	components: UpdateComponent[];
	/** Why the manifest could not be read (fresh); the rows then carry `latest: null` unless an older manifest was cached. */
	manifestError?: string;
}

/** What the owner does next when the host updates nothing by itself: plain words, no shell command or repo path. */
const MANUAL_STEP = "Use Update now in Pack > Machines.";

/** The one component state a machine card shows: a failed one first, else one installing; undefined when the host reports neither. */
export function worstHostState(components: { updateState?: UpdateState }[]): UpdateState | undefined {
	const states = components.flatMap((c) => (c.updateState ? [c.updateState] : []));
	return states.find((s) => s.state === "failed") ?? states.find((s) => s.state === "installing");
}

export const DEFAULT_MAIN_MANIFEST_URL = DEFAULT_MANIFEST_URL.replace("stable-manifest/stable.json", "main-manifest/main.json");

export const DEFAULT_AUTO_UPDATE_STATUS = "/var/lib/wolfpack-auto-update/status.json";

/**
 * Two timer intervals (30 min plus up to 5 min randomised delay, deploy/auto-update/wolfpack-auto-update.timer). Same value as
 * STALE_AFTER_MS in scripts/auto-update.mjs, which the console does not import (that file ships to hosts on its own).
 */
export const STALE_AFTER_MS = HOST_STALE_AFTER_MS;

type StatusUnit = { component?: string; state?: string; code?: string; message?: string; startedAt?: string; finishedAt?: string };
type StatusFile = { host?: string; enabled?: boolean; lastCheck?: string; disabledReason?: string; units?: Record<string, StatusUnit> };

function readStatusFile(file: string): StatusFile | undefined {
	try {
		const s = JSON.parse(readFileSync(file, "utf8")) as StatusFile;
		return s && typeof s === "object" && s.units && typeof s.units === "object" ? s : undefined;
	} catch {
		return undefined;
	}
}

/** Worst first: a component with several units (workerd, wolfd@*) shows the unit that needs a look. */
const RANK: HostUnitState[] = ["failed", "updating", "disabled", "updated", "idle"];

/** One component's status from the host file, or undefined when the file names no unit of it. */
export function componentStatus(s: StatusFile, component: string, nowMs: number = Date.now()): UpdateStatus | undefined {
	const units = Object.entries(s.units ?? {}).filter(([, u]) => u?.component === component && RANK.includes(u.state as HostUnitState));
	if (!units.length) return undefined;
	const [id, u] = units.sort(([, a], [, b]) => RANK.indexOf(a.state as HostUnitState) - RANK.indexOf(b.state as HostUnitState))[0]!;
	const state = u.state as HostUnitState;
	const at = state === "updating" ? u.startedAt : state === "updated" || state === "failed" ? u.finishedAt : undefined;
	const message = state === "disabled" ? s.disabledReason : u.message;
	const checked = Date.parse(s.lastCheck ?? "");
	// enabled:false is the timer being off (no reason, or "mode is button/off" written by a run that installs nothing). Only the kill switch is a pause.
	const manual = s.enabled === false && !s.disabledReason?.startsWith("kill switch");
	const stale = !manual && Number.isFinite(checked) && nowMs - checked > STALE_AFTER_MS;
	return {
		state,
		host: s.host ?? "unknown",
		lastCheck: s.lastCheck ?? "",
		...(id !== component ? { unit: id } : {}),
		...(state === "failed" && u.code ? { code: u.code } : {}),
		...((state === "failed" || state === "disabled") && message ? { message } : {}),
		...(at ? { at } : {}),
		...(stale ? { stale: true as const } : {}),
		...(manual ? { manual: true as const } : {}),
	};
}

function stepFor(component: string, st: UpdateStatus | undefined): string {
	if (!st) return MANUAL_STEP;
	const where = `${st.unit ?? component} on ${st.host}`;
	if (st.manual && st.state !== "failed" && st.state !== "updating") return `Manual updates on ${st.host}. ${MANUAL_STEP}`;
	switch (st.state) {
		case "failed":
			return failedLine({ error: plainError("pack", { code: st.code, message: st.message }) });
		case "updating":
			return `Updating ${where} now.`;
		case "disabled":
			return `Auto-updates are paused on ${st.host}. ${MANUAL_STEP}`;
		default:
			return `${st.host} updates itself on its next check (auto-update timer).`;
	}
}

/**
 * The console's release version. `dir` is the server's working directory: apps/console under `next dev` / `next start`
 * (`pnpm runtime:update` stamps apps/console/VERSION), and <payload>/apps/console in a release bundle, where the standalone server
 * chdirs and the stamp sits two levels up (<payload>/VERSION, scripts/build-server.mjs). Else <package.json>-dev.
 */
export function consoleVersion(dir: string = process.cwd()): string | undefined {
	// Runtime files beside the server, not build inputs: keep the file tracer from pulling in the whole cwd.
	const u = (...p: string[]) => pathToFileURL(path.join(/*turbopackIgnore: true*/ dir, ...p));
	return stampedVersion([u("VERSION"), u("..", "..", "VERSION")], u("package.json"));
}

export interface UpdatesOptions {
	env?: Record<string, string | undefined>;
	consoleDir?: string;
	/** Test seam: the platform whose status-file location applies (default process.platform). */
	platform?: NodeJS.Platform;
	probeTimeoutMs?: number;
	/** Clock in ms (default Date.now); decides `updateStatus.stale`. */
	now?: () => number;
	/** The manifest reader (default: one built from the env, cached for the life of the handler). `force` skips the cache. */
	manifest?: (o?: { force?: boolean }) => Promise<ManifestResult>;
}

const base = (u: string | undefined) => u?.trim().replace(/\/+$/, "") || undefined;

async function serviceVersion(url: string | undefined, service: string, timeoutMs: number): Promise<string | undefined> {
	if (!url) return undefined;
	const r = await probeHealth(`${url}/healthz`, { expectService: service, timeoutMs });
	return r.status !== "down" && typeof r.body?.version === "string" ? r.body.version : undefined;
}

export function createUpdatesHandler(o: UpdatesOptions = {}): (q?: { refresh?: boolean }) => Promise<UpdatesBody> {
	const env = o.env ?? process.env;
	const url = env.WOLFPACK_UPDATE_MANIFEST_URL?.trim() || DEFAULT_MANIFEST_URL;
	const off = url === "off";
	const stableManifest = off ? async (): Promise<ManifestResult> => ({ manifest: null, error: "update check is off (WOLFPACK_UPDATE_MANIFEST_URL=off)" }) : createManifestFetcher({ url });
	const mainManifest = off ? stableManifest : createManifestFetcher({ url: env.WOLFPACK_UPDATE_MAIN_MANIFEST_URL?.trim() || DEFAULT_MAIN_MANIFEST_URL });
	const subFile = subscriptionFile(env);
	// The subscribed channel (read on every request) picks the manifest; an injected `manifest` replaces both.
	const manifest = (q?: { refresh?: boolean }) => (o.manifest ?? (readSubscription(subFile).channel === "main" ? mainManifest : stableManifest))({ force: q?.refresh === true });
	const timeoutMs = o.probeTimeoutMs ?? 3_000;
	const own = consoleVersion(o.consoleDir);
	// On a Mac the updater (scripts/auto-update-mac.mjs) writes ~/.wolfpack/auto-update/status.json; elsewhere the sfo-01 path.
	const statusFile = env.WOLFPACK_AUTO_UPDATE_STATUS?.trim() || ((o.platform ?? process.platform) === "darwin" ? path.join(macAutoUpdateDir(undefined, env), "status.json") : DEFAULT_AUTO_UPDATE_STATUS);
	return async (q) => {
		const hostStatus = readStatusFile(statusFile);
		const channel = readSubscription(subFile).channel;
		const [m, hubd, workerd] = await Promise.all([
			manifest(q),
			serviceVersion(base(env.WOLFPACK_HUB_URL), "hubd", timeoutMs),
			serviceVersion(base(env.WOLFPACK_API_URL), "workerd", timeoutMs),
		]);
		// No workerd to probe (local mode, relay): the version the host updater last saw installed stands in (its units carry `current`).
		const fromStatus = (c: string) => Object.values(hostStatus?.units ?? {}).find((u) => u?.component === c && typeof (u as { current?: unknown }).current === "string") as { current?: string } | undefined;
		const rows = checkUpdates(m.manifest, { console: own, hubd, workerd: workerd ?? fromStatus("workerd")?.current, wolfd: undefined });
		const components = rows.map((r) => {
			const updateStatus = hostStatus && componentStatus(hostStatus, r.component, (o.now ?? Date.now)());
			const updateState = hostStatus && mapHostStatus(hostStatus, r.component, { now: (o.now ?? Date.now)(), channel });
			return { ...r, updateStep: stepFor(r.component, updateStatus), ...(updateStatus ? { updateStatus } : {}), ...(updateState ? { updateState } : {}) };
		});
		return {
			checkedAt: new Date().toISOString(),
			outdated: components.some((c) => c.outdated === true),
			components,
			...(m.error ? { manifestError: m.error } : {}),
		};
	};
}
