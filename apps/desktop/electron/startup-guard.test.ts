import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readyWatchdog } = require("./startup-guard.cjs") as {
	readyWatchdog: (o: { whenReady: Promise<void>; ms: number; log: (l: string) => void; exit: (code: number) => void; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }) => void;
};

// work-wolfpack-SzoWaBZ: a relaunch right after a SIGTERM quit once came up with the single-instance lock held, no
// window, no log line and Electron's ready event never firing. A silent process is worse than a quit the user can retry.
describe("readyWatchdog", () => {
	it("exits with a log line when ready has not fired in time", async () => {
		const lines: string[] = [];
		let exited: number | null = null;
		let fire: (() => void) | null = null;
		const setTimer = ((fn: () => void) => { fire = fn; return 1 as unknown as NodeJS.Timeout; }) as unknown as typeof setTimeout;
		readyWatchdog({ whenReady: new Promise(() => {}), ms: 20000, log: (l) => lines.push(l), exit: (c) => { exited = c; }, setTimer, clearTimer: (() => {}) as unknown as typeof clearTimeout });
		fire!();
		expect(exited).toBe(1);
		expect(lines).toEqual(["startup: Electron never became ready within 20s; exiting so the next launch starts clean"]);
	});

	it("does nothing once ready fires first", async () => {
		const lines: string[] = [];
		let exited: number | null = null;
		let cleared = false;
		let fire: (() => void) | null = null;
		const setTimer = ((fn: () => void) => { fire = fn; return 1 as unknown as NodeJS.Timeout; }) as unknown as typeof setTimeout;
		readyWatchdog({ whenReady: Promise.resolve(), ms: 20000, log: (l) => lines.push(l), exit: (c) => { exited = c; }, setTimer, clearTimer: (() => { cleared = true; }) as unknown as typeof clearTimeout });
		await Promise.resolve();
		expect(cleared).toBe(true);
		fire!(); // a late timer must be inert even if it still fires
		expect(exited).toBeNull();
		expect(lines).toEqual([]);
	});
});
