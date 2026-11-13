/**
 * PACK HEALTH SERVICE ACTIONS (work-wolfpack-yM3uTlj): owner-initiated rollback, next to restart (pack-health.ts).
 * Everything runs on the console's own host, argv only, never through the hub or a wolf.
 *
 * ROLLBACK  `systemctl --no-ask-password --no-block start wolfpack-rollback@<svc>.service` for svc in ROLLBACK_SERVICES (fixed), a root
 *       oneshot unit (deploy/console/wolfpack-rollback@.service) running `deploy-release.sh <svc> --rollback`. Allowed by the polkit rule
 *       deploy/console/50-console-restart.rules (start of exactly those three instances). One per service per 10 min. Never automatic:
 *       only POST /api/health/rollback calls it.
 * RELEASES  what a rollback would go back to: /opt/wolfpack-<svc>/{current,previous}/VERSION, read-only (world-readable, root-owned).
 */
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isNewerVersion as isNewer } from "../../core/pack/pack-health-view.ts";
import { execRunner, type CommandRunner, type PackHealth } from "./pack-health.ts";

export const ROLLBACK_SERVICES = ["hubd", "workerd", "console"] as const;
export type RollbackService = (typeof ROLLBACK_SERVICES)[number];
export const ROLLBACK_MIN_INTERVAL_MS = 10 * 60_000;

export type RollbackOutcome =
	| { ok: true; service: string; at: string; to: string | null }
	| { ok: false; service: string; code: "invalid_request" | "no_previous" | "previous_is_newer" | "rate_limited" | "failed"; message: string; retryAfterS?: number };


export interface Rollbacker {
	rollback(service: unknown, by: string): Promise<RollbackOutcome>;
}

/**
 * The rollback unit's last run, from `systemctl show wolfpack-rollback@<svc>.service`. `result` is systemd's Result (success, exit-code,
 * timeout, signal, ...) or "running" while the unit is activating; `exitStatus` the script's exit (deploy-release.sh --rollback: 0 ok,
 * 1 refused / nothing changed, 2 usage, 4 changed but unhealthy or half-done: needs a person); `at` when it exited. null: never ran.
 */
export interface RollbackLast {
	result: string;
	exitStatus: number | null;
	at: string | null;
}

export interface ReleaseInfo {
	service: RollbackService;
	/** Running release's version (current/VERSION first line, X.Y.Z with any +build), null when unreadable. */
	from: string | null;
	/** The kept previous release's version, null when it exists but has no readable VERSION. */
	to: string | null;
	/** The rollback unit's last run (null: never ran, or not read yet). */
	last: RollbackLast | null;
}

const versionIn = (dir: string): string | null => {
	try {
		const m = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)/.exec(readFileSync(path.join(dir, "VERSION"), "utf8").split("\n")[0]!.trim());
		return m ? m[1]! : null;
	} catch {
		return null;
	}
};

const SHOW_PROPS = "Result,ExecMainStatus,ActiveState,ExecMainExitTimestamp,AssertResult,AssertTimestamp";

const unixAt = (v: string | undefined): number | null => {
	const m = /^@(\d+)$/.exec(v ?? "");
	return m ? Number(m[1]) : null;
};

/**
 * `systemctl show` output (Key=Value lines) as the unit's last run. A start refused by the unit's AssertPathExists (rollback script or
 * previous release missing) runs nothing: systemd only sets AssertResult=no and AssertTimestamp, and leaves Result, ActiveState,
 * StateChangeTimestamp, InactiveEnterTimestamp and the exec times as they were (the unit never changes state). So an assert failure newer
 * than the last exit is the last run: result "assert" at AssertTimestamp.
 */
function parseShow(out: string): RollbackLast | null {
	const p = new Map<string, string>();
	for (const line of out.split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) p.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
	}
	const state = p.get("ActiveState") ?? "";
	if (state === "activating" || state === "deactivating" || state === "reloading") return { result: "running", exitStatus: null, at: null };
	const exitAt = unixAt(p.get("ExecMainExitTimestamp"));
	const assertAt = unixAt(p.get("AssertTimestamp"));
	if (p.get("AssertResult") === "no" && assertAt !== null && (exitAt === null || assertAt > exitAt)) {
		return { result: "assert", exitStatus: null, at: new Date(assertAt * 1000).toISOString() };
	}
	if (exitAt === null) return null; // never exited: never ran (or the unit is unknown)
	const status = Number(p.get("ExecMainStatus"));
	return { result: p.get("Result") || "unknown", exitStatus: Number.isInteger(status) ? status : null, at: new Date(exitAt * 1000).toISOString() };
}

/** `systemctl show` with a short timeout of its own (it rides on the health snapshot). */
const showRunner: CommandRunner = (file, args) =>
	new Promise((resolve) => {
		execFile(file, args, { timeout: 3_000, shell: false, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
			const c = (err as { code?: unknown } | null)?.code;
			resolve({ code: err ? (typeof c === "number" ? c : 1) : 0, stderr: String(stderr ?? "").slice(0, 500), stdout: String(stdout ?? "") });
		});
	});

export interface ReleaseReader {
	/** The rollback targets now (sync; rides on every snapshot). Starts a status read in the background when that is stale. */
	(): ReleaseInfo[];
	/** Re-reads the rollback units' status if it is older than `statusTtlMs`, and waits for a read in flight. */
	refresh(): Promise<void>;
}

/**
 * The rollback targets on this host: each of hubd/workerd/console installed under `<optRoot>/wolfpack-<svc>` with a `previous` link that
 * resolves to another release than `current`. Releases are cached for `ttlMs` (default 30 s); each target's rollback unit status
 * (`systemctl show wolfpack-rollback@<svc>.service -p Result,ExecMainStatus,ActiveState,ExecMainExitTimestamp,AssertResult,AssertTimestamp
 * --timestamp=unix`, argv,
 * 3 s timeout) for `statusTtlMs` (default 5 s), read in the background so the snapshot never waits on systemctl. `run` null: no status.
 */
export function createReleaseReader(o: { optRoot?: string; ttlMs?: number; statusTtlMs?: number; run?: CommandRunner | null; now?: () => number } = {}): ReleaseReader {
	const root = o.optRoot ?? "/opt";
	const ttl = o.ttlMs ?? 30_000;
	const statusTtl = o.statusTtlMs ?? 5_000;
	const run = o.run === undefined ? showRunner : o.run;
	const now = o.now ?? Date.now;
	let cache: { at: number; v: Omit<ReleaseInfo, "last">[] } | undefined;
	const lastOf = new Map<string, RollbackLast | null>();
	let statusAt: number | undefined;
	let inFlight: Promise<void> | undefined;
	const releases = (): Omit<ReleaseInfo, "last">[] => {
		const t = now();
		if (cache && t - cache.at < ttl) return cache.v;
		const v: Omit<ReleaseInfo, "last">[] = [];
		for (const service of ROLLBACK_SERVICES) {
			const dir = path.join(root, `wolfpack-${service}`);
			let cur: string, prev: string;
			try {
				cur = realpathSync(path.join(dir, "current"));
				prev = realpathSync(path.join(dir, "previous"));
			} catch {
				continue;
			}
			if (cur === prev) continue;
			v.push({ service, from: versionIn(cur), to: versionIn(prev) });
		}
		cache = { at: t, v };
		return v;
	};
	const readStatus = (): Promise<void> => {
		if (inFlight) return inFlight;
		if (!run || (statusAt !== undefined && now() - statusAt < statusTtl)) return Promise.resolve();
		statusAt = now();
		const targets = releases();
		inFlight = (async () => {
			for (const { service } of targets) {
				const r = await run("systemctl", ["show", `wolfpack-rollback@${service}.service`, "-p", SHOW_PROPS, "--timestamp=unix"]);
				lastOf.set(service, r.code === 0 ? parseShow(r.stdout ?? "") : null);
			}
		})()
			.catch(() => {})
			.finally(() => {
				inFlight = undefined;
			});
		return inFlight;
	};
	const reader = (() => {
		const v = releases();
		void readStatus();
		return v.map((r) => ({ ...r, last: lastOf.get(r.service) ?? null }));
	}) as ReleaseReader;
	reader.refresh = readStatus;
	return reader;
}

/**
 * Starts `wolfpack-rollback@<svc>.service` (argv systemctl, --no-block: the console itself may be the one rolled back). `service` must be
 * one of ROLLBACK_SERVICES and have a kept previous release (`releases()`); one rollback per service per `minIntervalMs` (default 10 min).
 */
export function createRollbacker(o: { releases: () => ReleaseInfo[]; run?: CommandRunner; now?: () => number; minIntervalMs?: number; log?: (m: string) => void }): Rollbacker {
	const run = o.run ?? execRunner;
	const now = o.now ?? Date.now;
	const minInterval = o.minIntervalMs ?? ROLLBACK_MIN_INTERVAL_MS;
	const log = o.log ?? ((m: string) => console.log(m));
	const last = new Map<string, number>();
	const starting = new Set<string>();
	return {
		async rollback(service, by) {
			const name = typeof service === "string" ? service : "";
			if (!(ROLLBACK_SERVICES as readonly string[]).includes(name)) {
				log(`console: health rollback REFUSED (unknown service ${JSON.stringify(String(service).slice(0, 80))}) by ${by}`);
				return { ok: false, service: name, code: "invalid_request", message: "only hubd, workerd and console can be rolled back" };
			}
			const rel = o.releases().find((r) => r.service === name);
			if (!rel) return { ok: false, service: name, code: "no_previous", message: "no previous release is kept on this host" };
			if (isNewer(rel.to, rel.from)) {
				log(`console: health rollback ${name} REFUSED (kept ${rel.to} is newer than running ${rel.from}) by ${by}`);
				return { ok: false, service: name, code: "previous_is_newer", message: `the kept release (${rel.to}) is newer than the running one (${rel.from}); deploy instead` };
			}
			const t = now();
			const prev = last.get(name);
			if (prev !== undefined && t - prev < minInterval) {
				log(`console: health rollback ${name} RATE-LIMITED by ${by}`);
				return { ok: false, service: name, code: "rate_limited", message: `rolled back less than ${Math.round(minInterval / 60_000)} min ago`, retryAfterS: Math.ceil((minInterval - (t - prev)) / 1000) };
			}
			if (starting.has(name)) return { ok: false, service: name, code: "rate_limited", message: "a rollback start is already being sent", retryAfterS: 2 };
			// The 10 min slot is taken only once systemctl accepted the start: a refused start (502) must not lock the owner out.
			starting.add(name);
			let r: Awaited<ReturnType<CommandRunner>>;
			try {
				r = await run("systemctl", ["--no-ask-password", "--no-block", "start", `wolfpack-rollback@${name}.service`]);
			} finally {
				starting.delete(name);
			}
			if (r.code === 0) last.set(name, t);
			log(`console: health rollback ${name} ${rel.from ?? "?"} -> ${rel.to ?? "?"} by ${by}: ${r.code === 0 ? "started" : `FAILED (exit ${r.code}) ${r.stderr.trim()}`}`);
			return r.code === 0 ? { ok: true, service: name, at: new Date(t).toISOString(), to: rel.to } : { ok: false, service: name, code: "failed", message: `systemctl exited ${r.code}` };
		},
	};
}

// ---- UPDATE (work-wolfpack-7eP9W3Z) ----

export const UPDATE_UNIT = "wolfpack-auto-update-now.service";

/** One component that has a newer stable release than the one running. */
export interface UpdateUnit {
	component: string;
	from: string | null;
	to: string;
}

export type UpdateOutcome =
	| { ok: true; service: "update"; at: string; units: UpdateUnit[] }
	| { ok: false; service: "update"; code: "invalid_request" | "no_update" | "up_to_date" | "running" | "failed"; message: string };

/** The components the pack panel can update one by one (units: wolfpack-auto-update-now@<component>.service). */
export const UPDATE_COMPONENTS = ["console", "hubd", "wolfd", "workerd"] as const;

export interface Updater {
	/** `component` undefined = Update all (the all-units unit); else just that component (400 unknown, 409 up_to_date). */
	update(by: string, component?: unknown): Promise<UpdateOutcome>;
	/** The manual unit's last run (systemctl show, argv, 3 s timeout); null: never ran or unreadable. */
	last(unit?: string): Promise<RollbackLast | null>;
	/** The components behind the latest stable release now. */
	available(refresh?: boolean): Promise<UpdateUnit[]>;
}

/**
 * Owner-initiated update: `systemctl --no-ask-password --no-block start wolfpack-auto-update-now.service` (root oneshot running
 * `auto-update.mjs run --now`; polkit allows exactly that start). Refused while nothing is behind (`available`), while the unit is
 * activating. The kill switch (and `mode: off`) stay the script's: it exits without installing. Every run it starts is manual
 * (`--now`), so it bypasses every failedTarget hold (a rollback hold or a failed install); a hold is cleared only by a successful
 * install of that unit. Never automatic: only POST /api/health/update calls it.
 */
export function createUpdater(o: { available: (refresh?: boolean) => Promise<UpdateUnit[]>; run?: CommandRunner; show?: CommandRunner; now?: () => number; log?: (m: string) => void }): Updater {
	const run = o.run ?? execRunner;
	const show = o.show ?? showRunner;
	const now = o.now ?? Date.now;
	const log = o.log ?? ((m: string) => console.log(m));
	let starting = false;
	const available = (refresh?: boolean) => o.available(refresh).catch(() => [] as UpdateUnit[]);
	const last = async (unit: string = UPDATE_UNIT): Promise<RollbackLast | null> => {
		const r = await show("systemctl", ["show", unit, "-p", SHOW_PROPS, "--timestamp=unix"]);
		return r.code === 0 ? parseShow(r.stdout ?? "") : null;
	};
	return {
		last,
		available,
		async update(by, component) {
			if (component !== undefined && !(UPDATE_COMPONENTS as readonly unknown[]).includes(component)) return { ok: false, service: "update", code: "invalid_request", message: "unknown component" };
			const all = await available();
			const units = component === undefined ? all : all.filter((u) => u.component === component);
			if (units.length === 0) return component === undefined ? { ok: false, service: "update", code: "no_update", message: "nothing is behind the latest release" } : { ok: false, service: "update", code: "up_to_date", message: `${component as string} is up to date` };
			const unit = component === undefined ? UPDATE_UNIT : `wolfpack-auto-update-now@${component as string}.service`;
			const t = now();
			// `starting` is set before the first await, so a second press arriving while `last()` is read cannot also start the unit.
			if (starting) return { ok: false, service: "update", code: "running", message: "an update is already running" };
			starting = true;
			let r: Awaited<ReturnType<CommandRunner>>;
			try {
				// One check: the all-units run or this component's run is still going (the script's own lock covers the rest).
				if ((await last(UPDATE_UNIT))?.result === "running" || (unit !== UPDATE_UNIT && (await last(unit))?.result === "running")) return { ok: false, service: "update", code: "running", message: "an update is already running" };
				r = await run("systemctl", ["--no-ask-password", "--no-block", "start", unit]);
			} finally {
				starting = false;
			}
			log(`console: health update ${units.map((u) => `${u.component} ${u.from ?? "?"} -> ${u.to}`).join(", ")} by ${by}: ${r.code === 0 ? "started" : `FAILED (exit ${r.code}) ${r.stderr.trim()}`}`);
			return r.code === 0 ? { ok: true, service: "update", at: new Date(t).toISOString(), units } : { ok: false, service: "update", code: "failed", message: `systemctl exited ${r.code}` };
		},
	};
}
