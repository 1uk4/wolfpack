#!/usr/bin/env node
/**
 * Automatic updates after a stable release (work-wolfpack-qrU6cCO). Pull, not push: each host polls the stable manifest
 * (scripts/stable-manifest.mjs, published by release-stable.yml) on its own timer and updates itself.
 *
 * This file is the shared core (`runAutoUpdate`) plus the sfo-01 host CLI. The Mac side is scripts/auto-update-mac.mjs.
 * It imports node builtins only, so setup copies it to the host as one file (deploy/auto-update/setup.sh).
 *
 * Rules (owner, binding):
 *   - Restart-only self-healing: an update that ends unhealthy is recorded as `failed` and left as it is. No new rollback here
 *     (deploy-release.sh keeps its own swap-back). The failed version is never retried by itself: only a newer release, or a
 *     person running `--clear-failed`, unblocks it. While any unit is failed, the host installs nothing else. Failure is held in
 *     `failedTarget` (a pause never clears it), and a unit left `updating` by a run that died counts as failed (code `interrupted`).
 *   - Opt-in: nothing runs unless WOLFPACK_AUTO_UPDATE=1 (the timer's env file) or the run is manual (`--now`).
 *     Kill switch: the file `<state dir>/auto-update.disabled` stops every run, manual ones too.
 *   - One run at a time (an atomic pid+token lock file, taken before any status write), and one unit at a time: units are updated
 *     in order and a failure stops the run.
 *   - Targets must be plain X.Y.Z (no prerelease GitHub release, no +build); a running X.Y.Z+build is read as X.Y.Z. A dev build
 *     (-dev) or anything unreadable is never touched.
 *   - The sha256 checked against GitHub's asset digest is passed to deploy-release.sh as --sha256, so it installs exactly that tarball.
 *   - No alerts: the result goes to a status file (shape: `AutoUpdateStatus` below), which the console's /api/updates shows.
 *
 * Status file (schema 1):
 *   { schema, host, enabled, disabledReason?, lastCheck, result: ok|updated|failed|disabled|manifest-error, error?,
 *     units: { <id>: { component, current, target, state: idle|updating|updated|failed|disabled, code?, message?, startedAt?, finishedAt? } } }
 *
 * sfo-01 CLI (root; installed by deploy/auto-update/setup.sh, run by wolfpack-auto-update.timer):
 *   node auto-update.mjs run [--now] [--clear-failed]     --now: manual run (works without WOLFPACK_AUTO_UPDATE=1)
 *   node auto-update.mjs status                            print the status file
 * Env (/etc/wolfpack/auto-update.env): WOLFPACK_AUTO_UPDATE=1, WOLFPACK_AUTO_UPDATE_WOLVES="hal2 ...",
 *   WOLFPACK_AUTO_UPDATE_UNITS (default "hubd workerd workerd-wolves wolfd console"), WOLFPACK_AUTO_UPDATE_STATE (/var/lib/wolfpack-auto-update),
 *   WOLFPACK_UPDATE_MANIFEST_URL (default: the GitHub stable manifest).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "1uk4/wolfpack";
export const MANIFEST_URL = `https://github.com/${REPO}/releases/download/stable-manifest/stable.json`;
export const MAIN_MANIFEST_URL = `https://github.com/${REPO}/releases/download/main-manifest/main.json`;

/**
 * Status readers call the updater stale when `lastCheck` is older than this: two timer intervals. Both timers run every 30 min
 * (wolfpack-auto-update.timer OnUnitActiveSec=30min plus up to 5 min RandomizedDelaySec; the Mac plist StartInterval 1800), so
 * 2 x 35 min. A run that finds the lock held writes nothing, so a stuck `<lock>.takeover` shows up here.
 * The console keeps its own copy (apps/console/src/server/updates-api.ts STALE_AFTER_MS): this file is copied to hosts on its own.
 */
export const STALE_AFTER_MS = 2 * 35 * 60_000;

/** "25m ago", "3h ago", "2d ago" for a past ISO time. */
export function ageText(iso, nowMs = Date.now()) {
	const min = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
	return min < 60 ? `${min}m ago` : min < 48 * 60 ? `${Math.floor(min / 60)}h ago` : `${Math.floor(min / 1440)}d ago`;
}

// ---- versions: only plain releases take part ----

const TARGET = /^(\d+)\.(\d+)\.(\d+)(?:-main\.([1-9]\d*))?$/;
const RUNNING = /^(\d+)\.(\d+)\.(\d+)(?:-main\.([1-9]\d*))?(?:\+[0-9A-Za-z.-]+)?$/;
// [x, y, z, pre]: pre is N of X.Y.Z-main.N, Infinity for a release (so a prerelease sorts below its release).
const parts = (m) => [+m[1], +m[2], +m[3], m[4] ? +m[4] : Infinity];
/**
 * [x, y, z, pre] of a release target: plain X.Y.Z, or X.Y.Z-main.N when `channel` is not stable; else null (build metadata, dev builds,
 * bare shas, and prereleases on the stable channel).
 */
export function releaseCore(v, channel = "stable") {
	const m = typeof v === "string" ? TARGET.exec(v) : null;
	return m && (!m[4] || channel !== "stable") ? parts(m) : null;
}
/** [x, y, z, pre] of a running version: X.Y.Z[-main.N], or with +build (a restamped checkout), else null. */
function runningCore(v) {
	const m = typeof v === "string" ? RUNNING.exec(v.trim()) : null;
	return m ? parts(m) : null;
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] === b[3] ? 0 : a[3] > b[3] ? 1 : -1);

/** True when running version `a` (X.Y.Z[-main.N][+build]) is at or above `b` (X.Y.Z[-main.N]); false when either is unreadable. */
export function versionAtLeast(a, b) {
	const x = runningCore(a);
	const y = runningCore(b);
	return !!x && !!y && cmp(x, y) >= 0;
}

export const CHANNELS = ["stable", "main"];
export const MODES = ["off", "button", "auto"];
/**
 * The subscription file `{schema:1, channel, mode}`; invalid parts fall back to stable + button. → null when the file is missing, or
 * corrupt (that one is logged): the caller then behaves as if there were no file (stable, WOLFPACK_AUTO_UPDATE=1 opt-in).
 */
export function readSubscription(file, log = console.error) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	try {
		const s = JSON.parse(text);
		return { channel: CHANNELS.includes(s?.channel) ? s.channel : "stable", mode: MODES.includes(s?.mode) ? s.mode : "button" };
	} catch {
		log(`auto-update: ${file} is not valid JSON; ignoring it (stable, WOLFPACK_AUTO_UPDATE decides)`);
		return null;
	}
}
const isDev = (v) => /-dev(?:[.+]|$)/.test(v);

// ---- files: status, lock, kill switch ----

export function readStatus(file) {
	try {
		const s = JSON.parse(fs.readFileSync(file, "utf8"));
		return s && typeof s === "object" && s.units && typeof s.units === "object" ? s : null;
	} catch {
		return null;
	}
}

function writeStatus(file, status) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o644 });
	fs.chmodSync(tmp, 0o644); // readable by the console user; holds versions and codes only
	fs.renameSync(tmp, file);
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === "EPERM";
	}
};

const readOrNull = (f) => {
	try {
		return fs.readFileSync(f, "utf8");
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
};

/**
 * Takes the lock: a file holding `<pid> <token>`, written to a temp file and hard-linked into place (atomic; fails if it exists).
 * → release function, or null when the lock is held (or a takeover cannot be done safely).
 *
 * A lock left by a dead pid is taken over under a second, short-lived lock `<file>.takeover` (same atomic link). Holding it, we
 * re-read the lock and unlink it only if its holder is still dead, then link ours. Nothing else can change a dead holder's lock
 * while we hold the takeover lock: the holder is gone, a fresh run cannot link over an existing file, and every other takeover
 * needs the takeover lock first. So a live lock is never moved or removed, however many runs race. If the takeover lock itself is
 * left by a dead pid (a run died inside that microsecond window), we return null and log it rather than break it: remove it by hand
 * (it is in /run, so a reboot clears it too). The release unlinks the lock while it holds our token; nobody takes over a live lock.
 *
 * `hooks.beforeTakeover`: an injected interleaving point for tests (runs between inspect and takeover); production passes no hooks.
 */
export function acquireLock(file, hooks = {}, log = console.error) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const token = `${process.pid} ${randomUUID()}\n`;
	const tmp = `${file}.${randomUUID()}.tmp`;
	const guard = `${file}.takeover`;
	const deadHolder = (text) => {
		const pid = Number.parseInt(text, 10);
		return !(Number.isInteger(pid) && pid > 0 && alive(pid));
	};
	const link = (target) => {
		try {
			fs.linkSync(tmp, target);
			return true;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			return false;
		}
	};
	fs.writeFileSync(tmp, token, { mode: 0o644 });
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (link(file))
				return () => {
					if (readOrNull(file) === token) fs.rmSync(file, { force: true });
				};
			const seen = readOrNull(file);
			if (seen === null) continue; // released in between: try again
			if (!deadHolder(seen)) return null;
			hooks.beforeTakeover?.();
			if (!link(guard)) {
				const g = readOrNull(guard);
				if (g !== null && deadHolder(g)) log(`auto-update: ${guard} was left by a run that died mid-takeover; remove it by hand`);
				return null; // another run is taking over (or the guard is stale): back off
			}
			try {
				const now = readOrNull(file);
				if (now !== null && !deadHolder(now)) return null; // someone took it in between: theirs
				fs.rmSync(file, { force: true }); // still a dead holder's lock, and nobody else can change it now
			} finally {
				fs.rmSync(guard, { force: true });
			}
		}
		return null;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

// ---- the run ----

/**
 * One check-and-update pass. Never throws for an expected failure; returns { result, status }.
 *   units        [{ id, component, ... }] in update order (`component` = the manifest key)
 *   statusFile, lockFile, disabledFile   paths
 *   mode         off | button | auto (the subscription file): off stops every run, button installs only on a manual run, auto also on
 *                the timer. Without it `enabled` (WOLFPACK_AUTO_UPDATE=1) decides, as before.
 *   channel      stable (default) | main: main also takes X.Y.Z-main.N targets
 *   only         [component] limit the run to these components
 *   enabled      the host opted in (timer runs); manual  a `--now` run; clearFailed  forget recorded failures first
 *   wolfd is never updated by a timer run (button only): an unattended run skips it, a manual run does not.
 *   now          clock () => Date
 *   deps         { fetchManifest() -> manifest, currentVersion(unit) -> string|null, verify?(unit, entry) -> {ok, sha256?, code?, message?},
 *                  install(unit, entry, verified) -> {ok, code?, message?}, probe(unit, entry) -> {healthy, message?} }
 *                `verified` is verify's result ({ ok: true } without verify), so install can pin the hash that was checked.
 * `result`: ok | updated | failed | disabled | locked | manifest-error. `locked` writes nothing (the other run owns the file).
 */
export async function runAutoUpdate(o) {
	const now = () => (o.now ? o.now() : new Date()).toISOString();
	const log = o.log ?? (() => {});
	const base = (extra) => ({ schema: 1, host: o.host, enabled: o.mode ? o.mode === "auto" : !!o.enabled, lastCheck: now(), ...extra });

	// Every branch writes the status file, so every branch takes the lock first; a held lock means the other run owns the file.
	const release = acquireLock(o.lockFile);
	if (!release) {
		log(`auto-update: another run holds ${o.lockFile}; nothing done`);
		return { result: "locked", status: readStatus(o.statusFile) };
	}
	try {
		return await locked(o, now, log, base);
	} finally {
		release();
	}
}

async function locked(o, now, log, base) {
	const prev = readStatus(o.statusFile);
	// We hold the lock, so a unit still `updating` belongs to a run that died mid-install: count it as a failure of that target.
	// Done before the pause check, so a paused run keeps the failure and a resume never reinstalls the interrupted version.
	const prevUnit = (u) => {
		const p = prev?.units?.[u.id];
		if (!p) return null;
		const s = { ...p };
		if (s.state === "updating" && !o.clearFailed && s.target) {
			s.failedTarget = s.target;
			s.code = "interrupted";
			s.message = "a previous run stopped mid-update; left as it is";
			s.finishedAt ??= now();
		}
		return s;
	};
	const channel = o.channel ?? "stable";
	const enabled = o.mode ? o.mode === "auto" : !!o.enabled;
	const disabledReason = fs.existsSync(o.disabledFile)
		? `kill switch: ${o.disabledFile} exists`
		: o.mode === "off"
			? "mode is off"
			: !enabled && !o.manual
				? o.mode
					? `mode is ${o.mode}: the timer installs nothing`
					: "not enabled (set WOLFPACK_AUTO_UPDATE=1, or run with --now)"
				: null;
	if (disabledReason) {
		// A pause shows at the top (enabled:false, disabledReason); a failed unit stays failed, so resuming never retries it.
		const units = Object.fromEntries(
			o.units.map((u) => {
				const s = prevUnit(u) ?? { component: u.component, current: null, target: null };
				s.state = s.failedTarget ? "failed" : "disabled";
				return [u.id, s];
			}),
		);
		const status = base({ enabled: false, disabledReason, result: "disabled", units });
		writeStatus(o.statusFile, status);
		log(`auto-update: disabled (${disabledReason})`);
		return { result: "disabled", status };
	}

	{
		const units = {};
		for (const u of o.units) {
			units[u.id] = prevUnit(u) ?? { component: u.component, current: null, target: null, state: "idle" };
			const s = units[u.id];
			if (o.clearFailed) delete s.failedTarget;
			// Failure is decided by failedTarget, not by the displayed state (a pause shows other states).
			s.state = s.failedTarget ? "failed" : s.state === "failed" || s.state === "disabled" ? "idle" : s.state;
		}
		const status = base({ result: "ok", units });
		const save = () => writeStatus(o.statusFile, status);

		let manifest;
		try {
			manifest = await o.deps.fetchManifest();
			if (!manifest?.components || typeof manifest.components !== "object") throw new Error("not a stable manifest");
		} catch (e) {
			status.result = "manifest-error";
			status.error = { code: "manifest", message: String(e?.message ?? e) };
			save();
			return { result: status.result, status };
		}

		// A recorded failure halts the host until a newer release of that unit appears (or someone clears it).
		const superseded = (u) => {
			const s = units[u.id];
			const latest = releaseCore(manifest.components[u.component]?.version, channel);
			const failedAt = releaseCore(s.failedTarget, "main");
			return !!latest && (!failedAt || cmp(latest, failedAt) > 0);
		};
		// Any manual run (Update all, a card's Update, --now [--only]) is the owner asking: it bypasses the hold. Timer runs respect it.
		const bypass = !!o.manual;
		const stillFailed = new Set(bypass ? [] : o.units.filter((u) => units[u.id].failedTarget && !superseded(u)).map((u) => u.id));
		let halt = [...stillFailed][0];

		for (const u of o.units) {
			const s = units[u.id];
			const entry = manifest.components[u.component];
			s.current = (await o.deps.currentVersion(u)) ?? null;
			s.target = entry?.version ?? null;
			if (o.only && !o.only.includes(u.component)) continue; // --only: the others are left as they are
			if (stillFailed.has(u.id)) {
				s.target = s.failedTarget;
				s.state = "failed";
				continue;
			}
			delete s.failedTarget; // superseded by a newer release (or cleared): this one may be tried
			const was = s.state;
			for (const k of ["code", "message"]) delete s[k];
			s.state = "idle";
			if (!o.manual && u.component === "wolfd") continue; // wolfd updates by button only: every timer run skips it
			const cur = runningCore(s.current);
			const tgt = releaseCore(s.target, channel);
			if (!entry || !tgt) s.message = "no stable release";
			else if (!s.current) s.message = "running version unknown (not installed?)";
			else if (isDev(s.current)) (s.code = "dev-build"), (s.message = "dev build: never auto-updated");
			else if (!cur) (s.code = "unreadable-version"), (s.message = `version "${s.current}" is not X.Y.Z`);
			else if (cmp(cur, tgt) >= 0) {
				if (was === "updated" && s.finishedAt) s.state = "updated";
			} else if (halt) s.message = `held: ${halt} failed; fix it, then run --clear-failed`;
			else {
				s.state = "updating";
				s.startedAt = now();
				delete s.finishedAt;
				save();
				log(`auto-update: ${u.id} ${s.current} -> ${s.target}`);
				let r;
				try {
					r = o.deps.verify ? await o.deps.verify(u, entry) : { ok: true };
					if (r.ok) r = await o.deps.install(u, entry, r);
					else r.code ??= "checksum";
					if (r.ok) {
						const h = await o.deps.probe(u, entry);
						r = h.healthy ? { ok: true } : { ok: false, code: "unhealthy", message: h.message ?? "unhealthy after the update" };
					} else r.code ??= "install-failed";
				} catch (e) {
					r = { ok: false, code: "error", message: String(e?.message ?? e) };
				}
				s.finishedAt = now();
				if (r.ok) {
					s.state = "updated";
					s.current = (await o.deps.currentVersion(u)) ?? s.target;
					if (status.result === "ok") status.result = "updated";
				} else {
					s.state = "failed";
					s.failedTarget = s.target;
					s.code = r.code;
					if (r.message) s.message = r.message;
					status.result = "failed";
					halt = u.id;
					log(`auto-update: ${u.id} FAILED (${r.code}${r.message ? `: ${r.message}` : ""}); left as it is, not retried for ${s.target}`);
				}
				save();
			}
		}
		if (o.units.some((u) => units[u.id].state === "failed") && status.result !== "failed") status.result = "failed";
		save();
		return { result: status.result, status };
	}
}

/**
 * A hand rollback of unit `component` (the unit id): records the version rolled back FROM as `failedTarget`, so the updater never
 * reinstalls it; only a newer release (or --clear-failed) lifts the hold. `currentVersion(unit)` reads that version (after the swap it is
 * the `previous` release). Takes the run lock; returns false when another run holds it or the unit/version is unknown.
 */
export function holdUnits({ statusFile, lockFile, units, component, currentVersion, host = "sfo-01", now = () => new Date() }) {
	const release = acquireLock(lockFile);
	if (!release) return false;
	try {
		const u = units.find((x) => x.id === component);
		const v = u ? currentVersion(u) : null;
		if (!u || !v) return false;
		const status = readStatus(statusFile) ?? { schema: 1, host, enabled: false, lastCheck: now().toISOString(), result: "ok", units: {} };
		const s = (status.units[u.id] ??= { component: u.component, current: null, target: null });
		Object.assign(s, { state: "failed", failedTarget: v, code: "rolled-back", message: `rolled back by hand from ${v}; held until a newer release`, finishedAt: now().toISOString() });
		writeStatus(statusFile, status);
		return true;
	} finally {
		release();
	}
}

// ---- asset verification: the published .sha256 must match GitHub's own digest of the asset ----

/**
 * → verify(unit, entry) for runAutoUpdate. A release is accepted only when the manifest tag is `<component>/v<version>`, the GitHub
 * Release exists (not a draft), and the hash in its `<asset>.sha256` file names the asset and equals the `sha256:` digest GitHub computed
 * for the asset on upload. deploy-release.sh then checks the downloaded tarball against that same .sha256 before installing.
 * `assets` = scripts/release-components.json; `fetch` is injectable.
 */
export function createReleaseVerifier({ assets, fetch: f = fetch, repo = REPO, timeoutMs = 20_000, channel = "stable" } = {}) {
	const get = async (url, accept) => {
		const res = await f(url, { headers: { accept, "user-agent": "wolfpack-auto-update" }, signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
		return res;
	};
	return async (unit, entry) => {
		const { component } = unit;
		const version = entry?.version;
		if (!releaseCore(version, channel) || entry.tag !== `${component}/v${version}`) return { ok: false, code: "checksum", message: `manifest tag ${entry?.tag} does not match ${component} ${version}` };
		const pattern = assets?.[component]?.asset;
		if (!pattern) return { ok: false, code: "checksum", message: `no release asset known for ${component}` };
		const asset = pattern.replace("{version}", version);
		let rel;
		let sumText;
		try {
			// {tag} is one path parameter: its "/" must be %2F (hubd/v0.1.14 -> hubd%2Fv0.1.14), the same as gh sends it.
			rel = await (await get(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(entry.tag)}`, "application/vnd.github+json")).json();
			// The download URL keeps the tag's "/" as a real path separator; each segment is encoded on its own.
			const seg = (s) => s.split("/").map(encodeURIComponent).join("/");
			sumText = await (await get(`https://github.com/${repo}/releases/download/${seg(entry.tag)}/${encodeURIComponent(`${asset}.sha256`)}`, "text/plain")).text();
		} catch (e) {
			return { ok: false, code: "release-unreachable", message: String(e?.message ?? e) };
		}
		if (rel?.draft) return { ok: false, code: "checksum", message: `${entry.tag} is a draft release` };
		if (rel?.prerelease && channel === "stable") return { ok: false, code: "checksum", message: `${entry.tag} is a prerelease` };
		const digest = /^sha256:([0-9a-f]{64})$/.exec(rel?.assets?.find((a) => a?.name === asset)?.digest ?? "")?.[1];
		if (!digest) return { ok: false, code: "checksum", message: `GitHub lists no sha256 digest for ${asset}` };
		const m = /^([0-9a-f]{64}) [ *](\S+)\s*$/.exec(sumText.trim());
		if (!m || m[2] !== asset) return { ok: false, code: "checksum", message: `${asset}.sha256 is malformed or names another file` };
		if (m[1] !== digest) return { ok: false, code: "checksum", message: `${asset}.sha256 does not match GitHub's digest of the asset` };
		return { ok: true, sha256: digest };
	};
}

// ---- sfo-01 wiring (UNVERIFIED until run on the host; see deploy/auto-update/RUNBOOK.md) ----

/** Units on sfo-01, in update order. wolfd is one unit per wolf (`wolfd@<name>`). */
export function sfoUnits(env) {
	const names = (env.WOLFPACK_AUTO_UPDATE_UNITS || "hubd workerd workerd-wolves wolfd console").split(/[\s,]+/).filter(Boolean);
	const wolves = (env.WOLFPACK_AUTO_UPDATE_WOLVES || "").split(/[\s,]+/).filter((w) => /^[a-z0-9][a-z0-9-]{0,26}$/.test(w));
	const out = [];
	for (const n of names) {
		if (n === "hubd") out.push({ id: "hubd", component: "hubd", versionFile: "/opt/wolfpack-hubd/current/VERSION", envFile: "/etc/wolfpack/hubd.env", envPrefix: "HUBD", args: [] });
		else if (n === "workerd") out.push({ id: "workerd", component: "workerd", versionFile: "/opt/wolfpack-workerd/current/VERSION", envFile: "/etc/wolfpack/workerd.env", envPrefix: "WORKERD", args: ["--unit", "link"] });
		else if (n === "workerd-wolves") out.push({ id: "workerd-wolves", component: "workerd", versionFile: "/opt/wolfpack-workerd-wolves/current/VERSION", envFile: "/etc/wolfpack/workerd-wolves.env", envPrefix: "WORKERD", host: "127.0.0.1", args: ["--unit", "wolves"] });
		else if (n === "console") out.push({ id: "console", component: "console", versionFile: "/opt/wolfpack-console/current/VERSION", systemdUnit: "console.service", args: [] });
		else if (n === "wolfd") for (const w of wolves) out.push({ id: `wolfd@${w}`, component: "wolfd", versionFile: `/home/wolf-${w}/release/VERSION`, systemdUnit: `wolfd@${w}.service`, args: ["--wolf", w] });
	}
	return out;
}

const firstLine = (file) => {
	try {
		return fs.readFileSync(file, "utf8").split("\n")[0].trim() || null;
	} catch {
		return null;
	}
};
const envValue = (file, key) => {
	try {
		const m = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
		return m?.[1].trim().replace(/^["']|["']$/g, "");
	} catch {
		return undefined;
	}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameRelease = (a, b) => {
	const x = runningCore(a); // the running side may carry +build
	const y = releaseCore(b, "main");
	return !!x && !!y && cmp(x, y) === 0;
};

/** Real deps on sfo-01: deploy-release.sh does download + sha256 + install (+ its existing swap-back); the probe reads /healthz. */
export function sfoDeps(env, { dir = path.dirname(fileURLToPath(import.meta.url)), log = console.log, channel = "stable" } = {}) {
	const assets = JSON.parse(fs.readFileSync(fs.existsSync(path.join(dir, "release-components.json")) ? path.join(dir, "release-components.json") : path.join(dir, "../scripts/release-components.json"), "utf8"));
	const manifestUrl = env.WOLFPACK_UPDATE_MANIFEST_URL?.trim() || (channel === "main" ? MAIN_MANIFEST_URL : MANIFEST_URL);
	const deployScript = path.join(dir, "deploy-release.sh");
	const RC = { 1: "refused", 2: "usage", 3: "rolled-back", 4: "rollback-unhealthy" };
	return {
		fetchManifest: async () => (await fetch(manifestUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).then((r) => (r.ok ? r : Promise.reject(new Error(`HTTP ${r.status}`))))).json(),
		currentVersion: (u) => firstLine(u.versionFile),
		verify: createReleaseVerifier({ assets, channel }),
		install: (u, entry, verified) => {
			// No default port exists: hubd.service, workerd.service and workerd-wolves.service refuse to start without <PFX>_PORT,
			// and deploy-release.sh skips its listening check. Without it the /healthz probe cannot run, so refuse before installing.
			if (u.envFile && !/^\d+$/.test(envValue(u.envFile, `${u.envPrefix}_PORT`) ?? "")) return { ok: false, code: "config", message: `${u.envFile} has no numeric ${u.envPrefix}_PORT; nothing installed` };
			const sha = verified?.sha256;
			if (!/^[0-9a-f]{64}$/.test(sha ?? "")) return { ok: false, code: "checksum", message: "no verified sha256 to pin the download to; nothing installed" };
			const r = spawnSync("bash", [deployScript, u.component, entry.version, ...u.args, "--sha256", sha], { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
			if (r.stderr) process.stderr.write(r.stderr);
			if (r.status === 0) return { ok: true };
			const code = /sha256/i.test(r.stderr ?? "") ? "checksum" : (RC[r.status] ?? "install-failed");
			return { ok: false, code, message: `deploy-release.sh exit ${r.status ?? r.signal}${code === "rolled-back" ? " (its own swap-back ran; the old release is live)" : ""}` };
		},
		probe: async (u, entry) => {
			if (!sameRelease(firstLine(u.versionFile), entry.version)) return { healthy: false, message: `${u.versionFile} is not ${entry.version}` };
			if (u.systemdUnit) {
				const r = spawnSync("systemctl", ["is-active", u.systemdUnit], { encoding: "utf8" });
				return r.stdout?.trim() === "active" ? { healthy: true } : { healthy: false, message: `${u.systemdUnit} is ${r.stdout?.trim() || "unknown"}` };
			}
			const host = u.host ?? envValue(u.envFile, `${u.envPrefix}_HOST`) ?? "127.0.0.1";
			const port = envValue(u.envFile, `${u.envPrefix}_PORT`);
			let last = "no answer";
			for (let i = 0; i < 10; i++) {
				try {
					const res = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(3_000) });
					const body = await res.json().catch(() => ({}));
					if (res.ok && body.ok !== false && sameRelease(body.version, entry.version)) return { healthy: true };
					last = `HTTP ${res.status}, version ${body.version ?? "?"}`;
				} catch (e) {
					last = String(e?.cause?.code ?? e?.message ?? e);
				}
				await sleep(3_000);
			}
			log(`auto-update: ${u.id} /healthz: ${last}`);
			return { healthy: false, message: `/healthz on ${host}:${port}: ${last}` };
		},
	};
}

/**
 * Exit code of `run`. 1: failed or manifest-error. With --now only (the console's Update button reads the exit status of
 * wolfpack-auto-update-now.service): 3 = kill switch set (`disabled`), 4 = another run holds the lock (`locked`), so a run that
 * did nothing is never shown as success. Timer runs keep exiting 0 for those, so the timer unit does not show failed.
 * Exit 2 is usage; 203 is systemd's "cannot exec" (the script is missing).
 */
export function exitCodeFor(result, manual) {
	if (result === "failed" || result === "manifest-error") return 1;
	if (manual && result === "disabled") return 3;
	if (manual && result === "locked") return 4;
	return 0;
}

export function sfoPaths(env) {
	const state = env.WOLFPACK_AUTO_UPDATE_STATE || "/var/lib/wolfpack-auto-update";
	return { subscriptionFile: env.WOLFPACK_SUBSCRIPTION_FILE?.trim() || "/var/lib/wolfpack-subscription/subscription.json", statusFile: path.join(state, "status.json"), disabledFile: path.join(state, "auto-update.disabled"), lockFile: "/run/wolfpack-auto-update.lock" };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [cmd, ...flags] = process.argv.slice(2);
	const env = process.env;
	const paths = sfoPaths(env);
	if (cmd === "status") {
		console.log(JSON.stringify(readStatus(paths.statusFile), null, 2));
	} else if (cmd === "run") {
		// The subscription file decides channel and mode; a missing file keeps today's behaviour (stable, WOLFPACK_AUTO_UPDATE=1 opt-in).
		const sub = readSubscription(paths.subscriptionFile) ?? { channel: "stable", mode: undefined };
		const oi = flags.indexOf("--only");
		const { result } = await runAutoUpdate({
			host: env.WOLFPACK_AUTO_UPDATE_HOST || "sfo-01",
			units: sfoUnits(env),
			...paths,
			enabled: env.WOLFPACK_AUTO_UPDATE === "1",
			mode: sub.mode,
			channel: sub.channel,
			only: oi >= 0 && flags[oi + 1] ? [flags[oi + 1]] : undefined,
			manual: flags.includes("--now"),
			clearFailed: flags.includes("--clear-failed"),
			deps: sfoDeps(env, { channel: sub.channel }),
			log: console.log,
		});
		console.log(`auto-update: ${result}`);
		process.exitCode = exitCodeFor(result, flags.includes("--now"));
	} else if (cmd === "hold" && flags[0]) {
		// After a hand rollback (the rollback unit calls this): hold the version rolled back from. Run BEFORE the swap, with the running version.
		const ok = holdUnits({ ...paths, units: sfoUnits(env), component: flags[0], currentVersion: (u) => firstLine(u.versionFile)?.replace(/\+.*$/, "") ?? null });
		if (ok) console.log(`auto-update: holding ${flags[0]}`);
		else {
			console.error(`auto-update: WARNING: could not hold ${flags[0]}; the version rolled back from is NOT held and a timer run may reinstall it`);
			process.exitCode = 1;
		}
	} else {
		console.error("usage: auto-update.mjs run [--now] [--only <component>] [--clear-failed] | hold <unit-id> | status");
		process.exitCode = 2;
	}
}
