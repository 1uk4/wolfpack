import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { wireUpdater, shouldCheckOnFocus, guardedCheck } = require("./update-events.cjs") as {
	wireUpdater: (u: EventEmitter, send: (e: unknown) => void, log?: (m: string) => void) => { last: () => unknown; setSource: (s: "user" | "background") => void };
	guardedCheck: (guard: { busy: boolean }, run: () => unknown) => Promise<unknown>;
	shouldCheckOnFocus: (lastAt: number | null, now: number) => boolean;
};

function setup() {
	const updater = new EventEmitter();
	const sent: unknown[] = [];
	const wired = wireUpdater(updater, (e) => sent.push(e), () => {});
	return { updater, sent, wired };
}

// The console maps these raw events with mapAppEvent; the shell must forward each step, in order (work-wolfpack-5IZ3Xc9).
describe("wireUpdater", () => {
	it("forwards the whole update run in order: checking, available, progress, downloaded", () => {
		const { updater, sent } = setup();
		updater.emit("checking-for-update");
		updater.emit("update-available", { version: "1.2.0" });
		updater.emit("download-progress", { percent: 41.6 });
		updater.emit("update-downloaded", { version: "1.2.0" });
		expect(sent).toEqual([
			{ type: "checking" },
			{ type: "available", version: "1.2.0" },
			{ type: "progress", percent: 41.6 },
			// legacy fields keep the existing restart banner working
			{ type: "downloaded", version: "1.2.0", status: "downloaded" },
		]);
	});

	it("forwards 'no update' with the version the feed reports", () => {
		const { updater, sent } = setup();
		updater.emit("update-not-available", { version: "1.1.0" });
		expect(sent).toEqual([{ type: "not-available", version: "1.1.0" }]);
	});

	it("forwards a failed background check as an error with the raw message and code", () => {
		const { updater, sent } = setup();
		updater.emit("error", Object.assign(new Error("net::ERR_INTERNET_DISCONNECTED"), { code: "ERR_X" }));
		expect(sent).toEqual([{ type: "error", message: "net::ERR_INTERNET_DISCONNECTED", code: "ERR_X" }]);
	});

	it("remembers the last event for a window opened mid-download", () => {
		const { updater, wired } = setup();
		expect(wired.last()).toBeNull();
		updater.emit("download-progress", { percent: 10 });
		expect(wired.last()).toEqual({ type: "progress", percent: 10 });
	});
});

describe("background errors", () => {
	it("tags a failed background check, but not a user check or a failed download", () => {
		const { updater, sent, wired } = setup();
		wired.setSource("background");
		updater.emit("checking-for-update");
		updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
		expect(sent[1]).toEqual({ type: "error", message: "net::ERR_INTERNET_DISCONNECTED", background: true });
		updater.emit("update-available", { version: "1.2.0" });
		updater.emit("error", new Error("download failed"));
		expect(sent[3]).toEqual({ type: "error", message: "download failed" });
		wired.setSource("user");
		updater.emit("checking-for-update");
		updater.emit("error", new Error("offline"));
		expect(sent[5]).toEqual({ type: "error", message: "offline" });
	});
});

describe("guardedCheck", () => {
	it("releases the in-flight guard when the check throws synchronously", async () => {
		const guard = { busy: false };
		await expect(guardedCheck(guard, () => { throw new Error("boom"); })).rejects.toThrow("boom");
		expect(guard.busy).toBe(false);
		await expect(guardedCheck(guard, () => 5)).resolves.toBe(5);
		expect(guard.busy).toBe(false);
	});
});

describe("shouldCheckOnFocus", () => {
	const H = 3_600_000;
	it("checks when never checked or the last check is over an hour old, not before", () => {
		expect(shouldCheckOnFocus(null, 5 * H)).toBe(true);
		expect(shouldCheckOnFocus(0, H + 1)).toBe(true);
		expect(shouldCheckOnFocus(0, H)).toBe(false);
		expect(shouldCheckOnFocus(10 * H, 10 * H + 60_000)).toBe(false);
	});
});
