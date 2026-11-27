/** Mac update start (work-wolfpack-BPQjV3y) at the createMacUpdater seam: launchctl is injected, the run-now request is a real temp file. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createMacUpdater } from "../../../src/server/pack/mac-updater.ts";

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-updater-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-26T10:00:00Z");
const mk = (o: { platform?: NodeJS.Platform; loaded?: boolean; kickstart?: number; getuid?: (() => number) | null } = {}) => {
	const calls: string[][] = [];
	const runNowFile = path.join(dir, "auto-update/run-now");
	const updater = createMacUpdater({
		platform: o.platform ?? "darwin",
		...(o.getuid === null ? { getuid: null } : { uid: 501 }),
		now: () => T0,
		runNowFile,
		run: async (file, args) => {
			calls.push([file, ...args]);
			const code = args[0] === "print" ? (o.loaded === false ? 113 : 0) : (o.kickstart ?? 0);
			return { code, stderr: "" };
		},
		log: () => {},
	});
	return { updater, calls, runNowFile };
};

describe("Mac update start (launchctl kickstart of the updater agent)", () => {
	it("leaves a run-now request and kickstarts the loaded agent, so a button-mode Mac installs", async () => {
		const { updater, calls, runNowFile } = mk();
		const out = await updater.start("device");
		assert.equal(out.ok, true);
		assert.equal(fs.existsSync(runNowFile), true);
		assert.deepEqual(calls.at(-1), ["launchctl", "kickstart", "gui/501/com.wolfpack.auto-update"]);
	});

	it("writes the request as a ms timestamp, owner-only; keeps a fresh one and replaces a stale one", async () => {
		const { updater, runNowFile } = mk();
		fs.mkdirSync(path.dirname(runNowFile), { recursive: true });
		fs.writeFileSync(runNowFile, `${T0 - 30_000}\n`);
		await updater.start("device");
		assert.equal(fs.readFileSync(runNowFile, "utf8").trim(), String(T0 - 30_000));
		fs.writeFileSync(runNowFile, `${T0 - 10 * 60_000}\n`);
		await updater.start("device");
		assert.equal(fs.readFileSync(runNowFile, "utf8").trim(), String(T0));
		assert.equal(fs.statSync(runNowFile).mode & 0o777, 0o600);
	});

	it("refuses when the user id is unknown instead of targeting gui/0", async () => {
		const { updater, calls } = mk({ getuid: null });
		const out = await updater.start("device");
		assert.equal(out.ok === false && out.code, "unsupported");
		assert.deepEqual(calls, []);
	});

	it("refuses off a Mac and runs nothing", async () => {
		const { updater, calls } = mk({ platform: "linux" });
		assert.deepEqual(await updater.start("device"), { ok: false, service: "update", code: "unsupported", message: "This computer has no Mac updater to start." });
		assert.deepEqual(calls, []);
	});

	it("refuses with a plain error when the agent is not loaded, and leaves no request behind", async () => {
		const { updater, calls, runNowFile } = mk({ loaded: false });
		assert.deepEqual(await updater.start("device"), { ok: false, service: "update", code: "not_installed", message: "The Mac updater is not turned on. Run: node scripts/auto-update-mac.mjs install" });
		assert.equal(calls.some((c) => c[1] === "kickstart"), false);
		assert.equal(fs.existsSync(runNowFile), false);
	});

	it("reports a failed kickstart and removes the request", async () => {
		const { updater, runNowFile } = mk({ kickstart: 1 });
		const out = await updater.start("device");
		assert.equal(out.ok, false);
		assert.equal(out.ok === false && out.code, "failed");
		assert.equal(fs.existsSync(runNowFile), false);
	});
});
