import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { acquireLock, runAutoUpdate } from "./auto-update.mjs";
// @ts-expect-error plain .mjs script
import { macChannel, macDeps, macPaths, macTimerEnabled, takeRunNow } from "./auto-update-mac.mjs";

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-upd-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("auto-update-mac channel", () => {
	it("follows stable + env opt-in without ~/.wolfpack/release-channel.json; with it, the file's channel and mode decide and main's manifest sha is checked out", async () => {
		const env = { HOME: dir, WOLFPACK_HOME: path.join(dir, ".wolfpack") };
		const p = macPaths(env, dir);
		expect(macChannel(p)).toEqual({ channel: "stable", mode: undefined });
		fs.mkdirSync(path.dirname(p.channelFile), { recursive: true });
		fs.writeFileSync(p.channelFile, JSON.stringify({ schema: 1, channel: "main", mode: "auto" }));
		expect(macChannel(p)).toEqual({ channel: "main", mode: "auto" });
		const seen: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (u: string) => (seen.push(String(u)), Response.json({ schema: 1, components: { workerd: { version: "0.1.6-main.2" } }, sha: "abc1234" }))) as typeof fetch;
		try {
			const deps = macDeps(p, env, "main");
			expect((await deps.fetchManifest()).sha).toBe("abc1234");
			expect(seen).toEqual(["https://github.com/1uk4/wolfpack/releases/download/main-manifest/main.json"]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("mac timer state", () => {
	it("is unknown (null) when the user id cannot be read, and never asks launchctl about gui/undefined", () => {
		const calls: unknown[] = [];
		expect(macTimerEnabled(undefined, (...a: unknown[]) => (calls.push(a), { status: 0 }))).toBeNull();
		expect(calls).toEqual([]);
		expect(macTimerEnabled(501, () => ({ status: 0 }))).toBe(true);
		expect(macTimerEnabled(501, () => ({ status: 113 }))).toBe(false);
	});
});

describe("auto-update-mac run-now request", () => {
	const NOW = Date.parse("2026-11-26T10:00:00Z");
	const setup = () => {
		const p = macPaths({ HOME: dir, WOLFPACK_HOME: path.join(dir, ".wolfpack") }, dir);
		fs.mkdirSync(path.dirname(p.runNowFile), { recursive: true });
		const installs: string[] = [];
		const run = () =>
			runAutoUpdate({
				host: "mac",
				units: [{ id: "stack", component: "workerd" }],
				statusFile: p.statusFile,
				lockFile: p.lockFile,
				disabledFile: p.disabledFile,
				enabled: false,
				mode: "button",
				manual: () => takeRunNow(p, NOW),
				now: () => new Date(NOW),
				deps: {
					fetchManifest: async () => ({ schema: 1, generatedAt: "x", components: { workerd: { version: "0.2.0", tag: "workerd/v0.2.0", sha: "abc", publishedAt: "2026-11-25T00:00:00Z", notesUrl: "https://example.test" } } }),
					currentVersion: () => "0.1.0",
					install: () => (installs.push("install"), { ok: true }),
					probe: () => ({ healthy: true }),
				},
			});
		return { p, installs, run };
	};

	it("a fresh request makes the run manual and is consumed: a button-mode Mac installs", async () => {
		const { p, installs, run } = setup();
		fs.writeFileSync(p.runNowFile, `${NOW - 5_000}\n`);
		expect((await run()).result).toBe("updated");
		expect(installs).toEqual(["install"]);
		expect(fs.existsSync(p.runNowFile)).toBe(false);
	});

	it("a stale request (older than 2 minutes) is deleted and the run stays unattended: nothing installs in button mode", async () => {
		const { p, installs, run } = setup();
		fs.writeFileSync(p.runNowFile, `${NOW - 10 * 60_000}\n`);
		expect((await run()).result).toBe("disabled");
		expect(installs).toEqual([]);
		expect(fs.existsSync(p.runNowFile)).toBe(false);
	});

	it("a run blocked by the lock leaves the request for the run that holds it", async () => {
		const { p, installs, run } = setup();
		fs.writeFileSync(p.runNowFile, `${NOW - 5_000}\n`);
		const release = acquireLock(p.lockFile);
		expect((await run()).result).toBe("locked");
		release();
		expect(installs).toEqual([]);
		expect(fs.existsSync(p.runNowFile)).toBe(true);
	});
});
