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
import { stampedVersion } from "@wolfpack/protocol/health-lag";

export type UpdateState = "idle" | "updating" | "updated" | "failed" | "disabled";

/** The host updater's view of one component (from its status file; scripts/auto-update.mjs). */
export interface UpdateStatus {
	state: UpdateState;
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
	/** true when `lastCheck` is older than STALE_AFTER_MS: the timer is not running, or every run finds the lock held. */
	stale?: true;
}

export interface UpdateComponent extends UpdateRow {
	/** What happens next for this component (shown with the notice). */
	updateStep: string;
	/** Present when the host's auto-update status file is readable. */
	updateStatus?: UpdateStatus;
}

export interface UpdatesBody {
	checkedAt: string;
	/** true when at least one component is known to be behind. */
	outdated: boolean;
	components: UpdateComponent[];
	/** Why the manifest could not be read (fresh); the rows then carry `latest: null` unless an older manifest was cached. */
	manifestError?: string;
}

const STEPS: Record<string, string> = {
	console: "Deploy the console release to sfo-01 (deploy/console/RUNBOOK.md); on the Mac, pnpm runtime:update.",
	hubd: "Deploy the hubd release to sfo-01 (deploy/hubd/RUNBOOK.md).",
	workerd: "On the Mac: pnpm runtime:update, then pnpm stack restart.",
	wolfd: "On the Mac: pnpm runtime:update, then pnpm stack restart (sfo-01 wolves: deploy the wolfd release).",
};

export const DEFAULT_AUTO_UPDATE_STATUS = "/var/lib/wolfpack-auto-update/status.json";

/**
 * Two timer intervals (30 min plus up to 5 min randomised delay, deploy/auto-update/wolfpack-auto-update.timer). Same value as
 * STALE_AFTER_MS in scripts/auto-update.mjs, which the console does not import (that file ships to hosts on its own).
 */
export const STALE_AFTER_MS = 2 * 35 * 60_000;

type StatusUnit = { component?: string; state?: string; code?: string; message?: string; startedAt?: string; finishedAt?: string };
type StatusFile = { host?: string; lastCheck?: string; disabledReason?: string; units?: Record<string, StatusUnit> };

function readStatusFile(file: string): StatusFile | undefined {
	try {
		const s = JSON.parse(readFileSync(file, "utf8")) as StatusFile;
		return s && typeof s === "object" && s.units && typeof s.units === "object" ? s : undefined;
	} catch {
		return undefined;
	}
}

/** Worst first: a component with several units (workerd, wolfd@*) shows the unit that needs a look. */
const RANK: UpdateState[] = ["failed", "updating", "disabled", "updated", "idle"];

/** One component's status from the host file, or undefined when the file names no unit of it. */
export function componentStatus(s: StatusFile, component: string, nowMs: number = Date.now()): UpdateStatus | undefined {
	const units = Object.entries(s.units ?? {}).filter(([, u]) => u?.component === component && RANK.includes(u.state as UpdateState));
	if (!units.length) return undefined;
	const [id, u] = units.sort(([, a], [, b]) => RANK.indexOf(a.state as UpdateState) - RANK.indexOf(b.state as UpdateState))[0]!;
	const state = u.state as UpdateState;
	const at = state === "updating" ? u.startedAt : state === "updated" || state === "failed" ? u.finishedAt : undefined;
	const message = state === "disabled" ? s.disabledReason : u.message;
	const checked = Date.parse(s.lastCheck ?? "");
	const stale = Number.isFinite(checked) && nowMs - checked > STALE_AFTER_MS;
	return {
		state,
		host: s.host ?? "unknown",
		lastCheck: s.lastCheck ?? "",
		...(id !== component ? { unit: id } : {}),
		...(state === "failed" && u.code ? { code: u.code } : {}),
		...((state === "failed" || state === "disabled") && message ? { message } : {}),
		...(at ? { at } : {}),
		...(stale ? { stale: true as const } : {}),
	};
}

function stepFor(component: string, st: UpdateStatus | undefined): string {
	if (!st) return STEPS[component] ?? "";
	const where = `${st.unit ?? component} on ${st.host}`;
	switch (st.state) {
		case "failed":
			return `Auto-update of ${where} failed (${st.code ?? "error"}); left as it is and not retried for this version. Fix it, then run auto-update.mjs run --now --clear-failed (deploy/auto-update/RUNBOOK.md).`;
		case "updating":
			return `Updating ${where} now.`;
		case "disabled":
			return `Auto-update is off on ${st.host}${st.message ? ` (${st.message})` : ""}. ${STEPS[component] ?? ""}`.trim();
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
	probeTimeoutMs?: number;
	/** Clock in ms (default Date.now); decides `updateStatus.stale`. */
	now?: () => number;
	/** The manifest reader (default: one built from the env, cached for the life of the handler). */
	manifest?: () => Promise<ManifestResult>;
}

const base = (u: string | undefined) => u?.trim().replace(/\/+$/, "") || undefined;

async function serviceVersion(url: string | undefined, service: string, timeoutMs: number): Promise<string | undefined> {
	if (!url) return undefined;
	const r = await probeHealth(`${url}/healthz`, { expectService: service, timeoutMs });
	return r.status !== "down" && typeof r.body?.version === "string" ? r.body.version : undefined;
}

export function createUpdatesHandler(o: UpdatesOptions = {}): () => Promise<UpdatesBody> {
	const env = o.env ?? process.env;
	const url = env.WOLFPACK_UPDATE_MANIFEST_URL?.trim() || DEFAULT_MANIFEST_URL;
	const off = url === "off";
	const manifest = o.manifest ?? (off ? async (): Promise<ManifestResult> => ({ manifest: null, error: "update check is off (WOLFPACK_UPDATE_MANIFEST_URL=off)" }) : createManifestFetcher({ url }));
	const timeoutMs = o.probeTimeoutMs ?? 3_000;
	const own = consoleVersion(o.consoleDir);
	const statusFile = env.WOLFPACK_AUTO_UPDATE_STATUS?.trim() || DEFAULT_AUTO_UPDATE_STATUS;
	return async () => {
		const hostStatus = readStatusFile(statusFile);
		const [m, hubd, workerd] = await Promise.all([
			manifest(),
			serviceVersion(base(env.WOLFPACK_HUB_URL), "hubd", timeoutMs),
			serviceVersion(base(env.WOLFPACK_API_URL), "workerd", timeoutMs),
		]);
		const rows = checkUpdates(m.manifest, { console: own, hubd, workerd, wolfd: undefined });
		const components = rows.map((r) => {
			const updateStatus = hostStatus && componentStatus(hostStatus, r.component, (o.now ?? Date.now)());
			return { ...r, updateStep: stepFor(r.component, updateStatus), ...(updateStatus ? { updateStatus } : {}) };
		});
		return {
			checkedAt: new Date().toISOString(),
			outdated: components.some((c) => c.outdated === true),
			components,
			...(m.error ? { manifestError: m.error } : {}),
		};
	};
}
