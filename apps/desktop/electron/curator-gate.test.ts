/** Seam: the curation gate decision (electron/curator-gate.cjs), a pure function of idle time, power and the last run. */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { shouldCurate, parseBatteryPercent } = createRequire(import.meta.url)("./curator-gate.cjs");

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const ok = { idleSeconds: 600, onBattery: false, batteryPercent: 100, lastRunAt: NOW - 60 * MIN, now: NOW };

describe("curation gate", () => {
	const cases: Array<[string, Partial<typeof ok> & { batteryPercent?: number | null; lastRunAt?: number | null }, boolean]> = [
		["10 minutes idle, 60 minutes since the last run, on AC: runs", {}, true],
		["9 minutes 59 seconds idle: waits", { idleSeconds: 599 }, false],
		["59 minutes since the last run: waits", { lastRunAt: NOW - 59 * MIN }, false],
		["never ran before: runs", { lastRunAt: null }, true],
		["on battery at 30%: runs", { onBattery: true, batteryPercent: 30 }, true],
		["on battery at 29%: waits", { onBattery: true, batteryPercent: 29 }, false],
		["on battery, level unknown: waits", { onBattery: true, batteryPercent: null }, false],
		["on AC, level unknown: runs", { onBattery: false, batteryPercent: null }, true],
	];
	it.each(cases)("%s", (_name, over, want) => {
		expect(shouldCurate({ ...ok, ...over })).toBe(want);
	});
});

describe("battery percent from pmset -g batt", () => {
	it("reads the internal battery only", () => {
		const laptop = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 5:12 remaining present: true\n";
		const charging = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t87%; charging; 0:40 remaining present: true\n";
		const mini = "Now drawing from 'AC Power'\n";
		const ups = "Now drawing from 'AC Power'\n -CyberPower UPS (id=1234)\t100%; AC attached; not charging present: true\n -InternalBattery-0 (id=4653155)\t42%; discharging; 2:00 remaining present: true\n";
		expect(parseBatteryPercent(laptop)).toBe(87);
		expect(parseBatteryPercent(charging)).toBe(87);
		expect(parseBatteryPercent(mini)).toBeNull();
		expect(parseBatteryPercent(ups)).toBe(42);
	});
});
