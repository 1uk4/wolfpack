import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, createReleaseVerifier, exitCodeFor, holdUnits, readStatus, readSubscription, runAutoUpdate, sfoDeps, versionAtLeast } from "./auto-update.mjs";

type Entry = { version: string; tag: string };
type Unit = { id: string; component: string };
const entry = (c: string, v: string) => ({ version: v, tag: `${c}/v${v}`, sha: "bfb4b5c3", publishedAt: "2026-11-09T03:21:10Z", notesUrl: `https://github.com/1uk4/wolfpack/releases/tag/${c}/v${v}` });
const manifest = (versions: Record<string, string>) => ({ schema: 1, generatedAt: "2026-11-09T03:30:00Z", components: Object.fromEntries(Object.entries(versions).map(([c, v]) => [c, entry(c, v)])) });

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-update-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * A fake host: `running` is what each unit reports; install moves it to the target unless `installResult` says otherwise;
 * `healthy` decides the probe. Records what was installed and probed.
 */
function host(o: { running: Record<string, string | null>; versions: Record<string, string>; healthy?: boolean; verify?: (u: Unit, e: Entry) => unknown }) {
	const installedWith: unknown[] = [];
	const calls: string[] = [];
	const state = { versions: o.versions, healthy: o.healthy ?? true };
	let t = Date.parse("2026-11-09T04:00:00Z");
	const units: Unit[] = Object.keys(o.running).map((id) => ({ id, component: id }));
	const run = (extra: Record<string, unknown> = {}) =>
		runAutoUpdate({
			host: "sfo-01",
			units,
			statusFile: path.join(dir, "status.json"),
			lockFile: path.join(dir, "run.lock"),
			disabledFile: path.join(dir, "auto-update.disabled"),
			enabled: true,
			now: () => new Date((t += 1000)),
			deps: {
				fetchManifest: async () => manifest(state.versions),
				currentVersion: (u: Unit) => o.running[u.id],
				...(o.verify ? { verify: o.verify } : {}),
				install: (u: Unit, e: Entry, verified: unknown) => {
					calls.push(`install ${u.id} ${e.version}`);
					installedWith.push(verified);
					o.running[u.id] = e.version;
					return { ok: true };
				},
				probe: (u: Unit, e: Entry) => {
					calls.push(`probe ${u.id} ${e.version}`);
					return { healthy: state.healthy, message: state.healthy ? undefined : "/healthz: ECONNREFUSED" };
				},
			},
			...extra,
		});
	return { run, calls, installedWith, state, status: () => readStatus(path.join(dir, "status.json")) };
}

describe("runAutoUpdate", () => {
	it("installs an outdated component, health-checks it and records it as updated; an up-to-date one is left alone", async () => {
		const h = host({ running: { hubd: "0.1.13", console: "0.1.18" }, versions: { hubd: "0.1.14", console: "0.1.18" } });
		const r = await h.run();
		expect(r.result).toBe("updated");
		expect(h.calls).toEqual(["install hubd 0.1.14", "probe hubd 0.1.14"]);
		expect(h.status()?.units.hubd).toMatchObject({ current: "0.1.14", target: "0.1.14", state: "updated" });
		expect(h.status()?.units.console).toMatchObject({ current: "0.1.18", target: "0.1.18", state: "idle" });
	});

	it("an unhealthy update is recorded as failed, left as it is, and the same version is not tried again", async () => {
		const h = host({ running: { hubd: "0.1.13", workerd: "0.1.4" }, versions: { hubd: "0.1.14", workerd: "0.1.5" }, healthy: false });
		expect((await h.run()).result).toBe("failed");
		// One unit at a time: the failure stops the run before workerd. No rollback step exists to be called.
		expect(h.calls).toEqual(["install hubd 0.1.14", "probe hubd 0.1.14"]);
		expect(h.status()?.units.hubd).toMatchObject({ state: "failed", code: "unhealthy", target: "0.1.14" });
		h.state.healthy = true;
		expect((await h.run()).result).toBe("failed");
		expect(h.calls).toHaveLength(2);
		expect(h.status()?.units.workerd).toMatchObject({ state: "idle", current: "0.1.4", target: "0.1.5" });
	});

	it("after a failure, a newer release of that component is tried", async () => {
		const h = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" }, healthy: false });
		await h.run();
		h.state.healthy = true;
		h.state.versions = { hubd: "0.1.15" };
		expect((await h.run()).result).toBe("updated");
		expect(h.calls.slice(2)).toEqual(["install hubd 0.1.15", "probe hubd 0.1.15"]);
		expect(h.status()?.units.hubd).toMatchObject({ state: "updated", current: "0.1.15" });
	});

	it("--clear-failed lets a person retry the failed version", async () => {
		const running: Record<string, string | null> = { hubd: "0.1.13" };
		const h = host({ running, versions: { hubd: "0.1.14" }, healthy: false });
		await h.run();
		running.hubd = "0.1.13"; // deploy-release.sh's own swap-back put the old release back
		h.state.healthy = true;
		expect((await h.run()).result).toBe("failed");
		expect((await h.run({ clearFailed: true })).result).toBe("updated");
		expect(h.calls.slice(2)).toEqual(["install hubd 0.1.14", "probe hubd 0.1.14"]);
	});

	it("does nothing when the kill-switch file exists (even a manual run) or the host has not opted in, and says so in the status", async () => {
		const h = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" } });
		fs.writeFileSync(path.join(dir, "auto-update.disabled"), "");
		expect((await h.run({ manual: true })).result).toBe("disabled");
		expect(h.status()).toMatchObject({ result: "disabled", units: { hubd: { state: "disabled" } } });
		fs.rmSync(path.join(dir, "auto-update.disabled"));
		expect((await h.run({ enabled: false })).result).toBe("disabled");
		expect(h.calls).toEqual([]);
		expect((await h.run({ enabled: false, manual: true })).result).toBe("updated");
	});

	it("gates on the mode: off is a kill switch even for --now, button installs only on --now, auto installs on the timer too", async () => {
		const h = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" } });
		expect((await h.run({ mode: "off", manual: true })).result).toBe("disabled");
		expect((await h.run({ mode: "button" })).result).toBe("disabled");
		expect(h.calls).toEqual([]);
		expect((await h.run({ mode: "button", manual: true })).result).toBe("updated");
		const a = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" } });
		expect((await a.run({ mode: "auto" })).result).toBe("updated");
	});

	it("takes -main.N targets only off the stable channel, and orders them below their release", async () => {
		const s = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14-main.2" } });
		expect((await s.run()).result).toBe("ok");
		expect(s.calls).toEqual([]);
		const m = host({ running: { hubd: "0.1.14-main.1", workerd: "0.1.5", console: "0.1.9-main.3" }, versions: { hubd: "0.1.14-main.2", workerd: "0.1.5-main.9", console: "0.1.9" } });
		expect((await m.run({ channel: "main" })).result).toBe("updated");
		// workerd 0.1.5 is newer than 0.1.5-main.9: left alone; console moves from its prerelease to the release.
		expect(m.calls).toEqual(["install hubd 0.1.14-main.2", "probe hubd 0.1.14-main.2", "install console 0.1.9", "probe console 0.1.9"]);
	});

	it("--only updates just that component and leaves the others untouched", async () => {
		const h = host({ running: { hubd: "0.1.13", console: "0.1.8" }, versions: { hubd: "0.1.14", console: "0.1.9" } });
		expect((await h.run({ manual: true, only: ["console"] })).result).toBe("updated");
		expect(h.calls).toEqual(["install console 0.1.9", "probe console 0.1.9"]);
	});

	it("never auto-updates wolfd on the timer, but a manual run (the button) does, in auto mode too", async () => {
		const h = host({ running: { hubd: "0.1.13", wolfd: "0.1.13" }, versions: { hubd: "0.1.14", wolfd: "0.1.14" } });
		expect((await h.run({ mode: "auto" })).result).toBe("updated");
		expect(h.calls).toEqual(["install hubd 0.1.14", "probe hubd 0.1.14"]);
		expect((await h.run({ mode: "auto", manual: true, only: ["wolfd"] })).result).toBe("updated");
		expect(h.calls.slice(2)).toEqual(["install wolfd 0.1.14", "probe wolfd 0.1.14"]);
	});

	it("a timer run skips wolfd even on the plain WOLFPACK_AUTO_UPDATE=1 path (no mode) and clears its stale message", async () => {
		const h = host({ running: { wolfd: "0.1.13" }, versions: { wolfd: "0.1.14" } });
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ schema: 1, units: { wolfd: { component: "wolfd", current: "0.1.13", target: "0.1.14", state: "idle", code: "old", message: "stale" } } }));
		expect((await h.run()).result).toBe("ok");
		expect(h.calls).toEqual([]);
		expect(h.status()?.units.wolfd.message).toBeUndefined();
		expect(h.status()?.units.wolfd.code).toBeUndefined();
	});

	it("any manual run (Update all or a card's --only) bypasses the failed hold (the owner asked), a timer run does not", async () => {
		const running: Record<string, string | null> = { hubd: "0.1.13" };
		const h = host({ running, versions: { hubd: "0.1.14" }, healthy: false });
		expect((await h.run()).result).toBe("failed");
		h.state.healthy = true;
		running.hubd = "0.1.13"; // the fake install moved it; put the old release back
		expect((await h.run()).result).toBe("failed");
		expect(h.calls).toHaveLength(2);
		expect((await h.run({ manual: true })).result).toBe("updated");
		expect(h.calls).toHaveLength(4);
	});

	it("a manual run clears a failed-install hold only by installing that unit; a manual run that installs nothing keeps it", async () => {
		const running: Record<string, string | null> = { hubd: "0.1.13" };
		const h = host({ running, versions: { hubd: "0.1.14" }, healthy: false });
		await h.run();
		expect(h.status()?.units.hubd).toMatchObject({ state: "failed", failedTarget: "0.1.14" });
		h.state.healthy = true;
		running.hubd = "0.1.14"; // already at the target (put there by hand): the manual run has nothing to install
		await h.run({ manual: true });
		expect(h.calls).toHaveLength(2);
		expect(h.status()?.units.hubd).toMatchObject({ state: "failed", failedTarget: "0.1.14" });
		running.hubd = "0.1.13";
		await h.run(); // a timer run still respects the hold
		expect(h.calls).toHaveLength(2);
		expect((await h.run({ manual: true })).result).toBe("updated");
		expect(h.calls).toHaveLength(4);
		expect(h.status()?.units.hubd).toMatchObject({ state: "updated", current: "0.1.14" });
		expect(h.status()?.units.hubd.failedTarget).toBeUndefined();
	});

	it("a hand rollback holds the version it left until a newer release is published", async () => {
		const h = host({ running: { hubd: "0.1.14" }, versions: { hubd: "0.1.14" } });
		expect((await h.run()).result).toBe("ok");
		holdUnits({ statusFile: path.join(dir, "status.json"), lockFile: path.join(dir, "run.lock"), units: [{ id: "hubd", component: "hubd" }], component: "hubd", currentVersion: () => "0.1.14" });
		expect(h.status()?.units.hubd).toMatchObject({ failedTarget: "0.1.14", state: "failed", code: "rolled-back" });
		// The rollback put 0.1.13 live; auto must not reinstall the held 0.1.14.
		const held = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" } });
		expect((await held.run()).result).toBe("failed");
		expect(held.calls).toEqual([]);
		const newer = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.15" } });
		expect((await newer.run()).result).toBe("updated");
	});

	it("a workerd rollback holds both workerd units", async () => {
		const units = ["workerd", "workerd-wolves", "hubd"].map((id) => ({ id, component: id === "hubd" ? "hubd" : "workerd" }));
		const statusFile = path.join(dir, "status.json");
		expect(holdUnits({ statusFile, lockFile: path.join(dir, "run.lock"), units, component: "workerd", currentVersion: () => "0.1.5" })).toBe(true);
		const s = readStatus(statusFile)?.units;
		expect(s?.workerd).toMatchObject({ failedTarget: "0.1.5", state: "failed" });
		expect(s?.["workerd-wolves"]).toMatchObject({ failedTarget: "0.1.5", state: "failed" });
		expect(s?.hubd).toBeUndefined();
	});

	it("a pause keeps a failure: after pausing and resuming, the failed version is still not installed again", async () => {
		const h = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" }, healthy: false });
		await h.run();
		h.state.healthy = true;
		fs.writeFileSync(path.join(dir, "auto-update.disabled"), "");
		expect((await h.run()).result).toBe("disabled");
		expect(h.status()).toMatchObject({ enabled: false, result: "disabled", units: { hubd: { state: "failed", failedTarget: "0.1.14" } } });
		fs.rmSync(path.join(dir, "auto-update.disabled"));
		expect((await h.run({ enabled: false })).result).toBe("disabled");
		expect((await h.run()).result).toBe("failed");
		expect(h.calls).toEqual(["install hubd 0.1.14", "probe hubd 0.1.14"]);
		expect(h.status()?.units.hubd).toMatchObject({ state: "failed", target: "0.1.14" });
	});

	it("a unit left mid-update by a run that died is recorded as failed (interrupted) and not installed again", async () => {
		const h = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" } });
		const file = path.join(dir, "status.json");
		const died = JSON.stringify({ schema: 1, host: "sfo-01", enabled: true, result: "ok", units: { hubd: { component: "hubd", current: "0.1.13", target: "0.1.14", state: "updating", startedAt: "2026-11-09T03:59:00Z" } } });
		fs.writeFileSync(file, died);
		expect((await h.run()).result).toBe("failed");
		expect(h.calls).toEqual([]);
		expect(h.status()?.units.hubd).toMatchObject({ state: "failed", code: "interrupted", failedTarget: "0.1.14" });
		// The same when the run that dies is followed by a paused run: resuming must not install the interrupted version again.
		fs.writeFileSync(file, died);
		fs.writeFileSync(path.join(dir, "auto-update.disabled"), "");
		expect((await h.run()).result).toBe("disabled");
		fs.rmSync(path.join(dir, "auto-update.disabled"));
		expect((await h.run()).result).toBe("failed");
		expect(h.calls).toEqual([]);
		expect(h.status()?.units.hubd).toMatchObject({ state: "failed", code: "interrupted", failedTarget: "0.1.14" });
	});

	it("does nothing while another live run holds the lock", async () => {
		const h = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" } });
		fs.writeFileSync(path.join(dir, "run.lock"), `${process.pid}\n`);
		expect((await h.run()).result).toBe("locked");
		expect(h.calls).toEqual([]);
		expect(fs.readFileSync(path.join(dir, "run.lock"), "utf8")).toBe(`${process.pid}\n`);
		// A paused or not-enabled run also leaves the status file to the run that holds the lock.
		fs.writeFileSync(path.join(dir, "auto-update.disabled"), "");
		expect((await h.run()).result).toBe("locked");
		expect((await h.run({ enabled: false })).result).toBe("locked");
		expect(h.status()).toBeNull();
	});

	it("never auto-updates a dev build or an unreadable version", async () => {
		const h = host({ running: { hubd: "0.1.14-dev+abc1234", workerd: "4a17d2e" }, versions: { hubd: "0.1.15", workerd: "0.1.5" } });
		expect((await h.run()).result).toBe("ok");
		expect(h.calls).toEqual([]);
		expect(h.status()?.units.hubd).toMatchObject({ state: "idle", code: "dev-build" });
		expect(h.status()?.units.workerd).toMatchObject({ state: "idle", code: "unreadable-version" });
	});

	it("refuses to install when the asset check fails, and records it as failed with code checksum", async () => {
		const h = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" }, verify: () => ({ ok: false, message: "hubd-v0.1.14-linux-x64.tar.gz.sha256 does not match" }) });
		expect((await h.run()).result).toBe("failed");
		expect(h.calls).toEqual([]);
		expect(h.status()?.units.hubd).toMatchObject({ state: "failed", code: "checksum" });
	});

	it("hands the sha256 the asset check verified to the install, so the deploy installs exactly that tarball", async () => {
		const sha = "4a17d2ea4983883c09b69e64081d4acf78ab56a26ffc3d1d847c3ce4c3a57e63";
		const h = host({ running: { hubd: "0.1.13" }, versions: { hubd: "0.1.14" }, verify: () => ({ ok: true, sha256: sha }) });
		expect((await h.run()).result).toBe("updated");
		expect(h.installedWith).toEqual([{ ok: true, sha256: sha }]);
	});
});

describe("sfoDeps install", () => {
	it("refuses before deploy-release.sh runs when the unit's env file has no port (there is no default) or no verified sha256 was handed over", () => {
		const envFile = path.join(dir, "hubd.env");
		fs.writeFileSync(envFile, "HUBD_HOST=127.0.0.1\n");
		// dir holds no deploy-release.sh: reaching it would fail with a different code.
		const deps = sfoDeps({}, { dir: path.join(import.meta.dirname, "../scripts"), log: () => {} });
		const unit = { id: "hubd", component: "hubd", versionFile: path.join(dir, "VERSION"), envFile, envPrefix: "HUBD", args: [] };
		const sha = "4a17d2ea4983883c09b69e64081d4acf78ab56a26ffc3d1d847c3ce4c3a57e63";
		expect(deps.install(unit, entry("hubd", "0.1.14"), { ok: true, sha256: sha })).toMatchObject({ ok: false, code: "config" });
		fs.writeFileSync(envFile, "HUBD_HOST=127.0.0.1\nHUBD_PORT=3150\n");
		expect(deps.install(unit, entry("hubd", "0.1.14"), { ok: true })).toMatchObject({ ok: false, code: "checksum" });
	});
});

describe("acquireLock", () => {
	it("two runs taking over the same stale lock at once end with exactly one holder, and only the holder's release removes it", () => {
		const file = path.join(dir, "run.lock");
		fs.writeFileSync(file, "2147483646\n"); // left by a pid that is gone
		let second: (() => void) | null = null;
		// The second run inspects and takes over the stale lock in the gap between the first run's inspection and its takeover.
		const first = acquireLock(file, { beforeTakeover: () => (second = acquireLock(file)) });
		expect(first).toBeNull();
		expect(typeof second).toBe("function");
		const held = fs.readFileSync(file, "utf8");
		expect(acquireLock(file)).toBeNull();
		expect(fs.readFileSync(file, "utf8")).toBe(held);
		(second as unknown as () => void)();
		expect(fs.existsSync(file)).toBe(false);
	});
});

describe("createReleaseVerifier", () => {
	const ASSET = "hubd-v0.1.14-linux-x64.tar.gz";
	const DIGEST = "4a17d2ea4983883c09b69e64081d4acf78ab56a26ffc3d1d847c3ce4c3a57e63";
	const assets = { hubd: { asset: "hubd-v{version}-linux-x64.tar.gz" } };
	// GitHub is the boundary: the release API (asset digests) and the published .sha256 asset.
	// The API takes the tag as one path parameter, so its "/" is sent as %2F (as gh does).
	const github = (sumFile: string, rel: Record<string, unknown> = {}) => async (url: string) => {
		if (url === "https://api.github.com/repos/1uk4/wolfpack/releases/tags/hubd%2Fv0.1.14") return new Response(JSON.stringify({ draft: false, prerelease: false, assets: [{ name: ASSET, digest: `sha256:${DIGEST}` }], ...rel }));
		if (url === `https://github.com/1uk4/wolfpack/releases/download/hubd/v0.1.14/${ASSET}.sha256`) return new Response(sumFile);
		return new Response("not found", { status: 404 });
	};
	const unit = { id: "hubd", component: "hubd" };

	it("accepts a release whose .sha256 matches GitHub's digest of the asset and refuses one that does not", async () => {
		const good = createReleaseVerifier({ assets, fetch: github(`${DIGEST}  ${ASSET}\n`) as typeof fetch });
		expect(await good(unit, entry("hubd", "0.1.14"))).toEqual({ ok: true, sha256: DIGEST });
		const bad = createReleaseVerifier({ assets, fetch: github(`${"0".repeat(64)}  ${ASSET}\n`) as typeof fetch });
		expect(await bad(unit, entry("hubd", "0.1.14"))).toMatchObject({ ok: false, code: "checksum" });
	});

	it("accepts a -main.N prerelease only on the main channel", async () => {
		const asset = ASSET.replace("0.1.14", "0.1.14-main.2");
		const fetchMain = (async (url: string) => {
			if (url.includes("/releases/tags/")) return new Response(JSON.stringify({ draft: false, prerelease: true, assets: [{ name: asset, digest: `sha256:${DIGEST}` }] }));
			return new Response(`${DIGEST}  ${asset}\n`);
		}) as unknown as typeof fetch;
		const e = entry("hubd", "0.1.14-main.2");
		expect(await createReleaseVerifier({ assets, fetch: fetchMain, channel: "main" })(unit, e)).toEqual({ ok: true, sha256: DIGEST });
		expect(await createReleaseVerifier({ assets, fetch: fetchMain })(unit, e)).toMatchObject({ ok: false, code: "checksum" });
	});

	it("refuses a prerelease", async () => {
		const v = createReleaseVerifier({ assets, fetch: github(`${DIGEST}  ${ASSET}\n`, { prerelease: true }) as typeof fetch });
		expect(await v(unit, entry("hubd", "0.1.14"))).toMatchObject({ ok: false, code: "checksum" });
	});

	it("refuses a manifest entry whose tag does not match its version, or whose version is not plain X.Y.Z", async () => {
		const v = createReleaseVerifier({ assets, fetch: github(`${DIGEST}  ${ASSET}\n`) as typeof fetch });
		expect(await v(unit, { version: "0.1.14", tag: "hubd/v0.1.13" })).toMatchObject({ ok: false, code: "checksum" });
		expect(await v(unit, { version: "0.1.14+b1", tag: "hubd/v0.1.14+b1" })).toMatchObject({ ok: false, code: "checksum" });
	});
});

describe("versionAtLeast", () => {
	it("orders prereleases below their release and by number, and reads a running +build as its version", () => {
		expect(versionAtLeast("0.1.6-main.1", "0.1.6-main.2")).toBe(false);
		expect(versionAtLeast("0.1.6-main.2+abc1234", "0.1.6-main.2")).toBe(true);
		expect(versionAtLeast("0.1.6", "0.1.6-main.9")).toBe(true);
		expect(versionAtLeast("0.1.6-main.9", "0.1.6")).toBe(false);
		expect(versionAtLeast(null, "0.1.6")).toBe(false);
	});
});

describe("readSubscription", () => {
	it("returns null for a missing or corrupt file (so the caller falls back to env-based auto, and a corrupt one is logged), and reads a valid one", () => {
		const f = path.join(dir, "subscription.json");
		const logs: string[] = [];
		expect(readSubscription(f, (m: string) => logs.push(m))).toBeNull();
		expect(logs).toEqual([]);
		fs.writeFileSync(f, "{nope");
		expect(readSubscription(f, (m: string) => logs.push(m))).toBeNull();
		expect(logs).toHaveLength(1);
		fs.writeFileSync(f, JSON.stringify({ schema: 1, channel: "beta", mode: "auto" }));
		expect(readSubscription(f)).toEqual({ channel: "stable", mode: "auto" });
		fs.writeFileSync(f, JSON.stringify({ schema: 1, channel: "main", mode: "off" }));
		expect(readSubscription(f)).toEqual({ channel: "main", mode: "off" });
	});
});

describe("exitCodeFor", () => {
	it("a manual run exits non-zero when the kill switch or the lock stopped it, so the Update button cannot report a false success", () => {
		expect(exitCodeFor("disabled", true)).toBe(3);
		expect(exitCodeFor("locked", true)).toBe(4);
		expect(exitCodeFor("ok", true)).toBe(0);
		expect(exitCodeFor("updated", true)).toBe(0);
		expect(exitCodeFor("failed", true)).toBe(1);
		expect(exitCodeFor("manifest-error", true)).toBe(1);
	});

	it("a timer run keeps exiting 0 when disabled or locked, so the timer unit never shows failed", () => {
		expect(exitCodeFor("disabled", false)).toBe(0);
		expect(exitCodeFor("locked", false)).toBe(0);
		expect(exitCodeFor("failed", false)).toBe(1);
	});
});
