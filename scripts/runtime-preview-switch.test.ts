import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { runSwitch } from "./runtime-preview-switch.mjs";

let tmp: string, stateFile: string, plist: string;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rtsw-")));
	stateFile = path.join(tmp, "state.json");
	plist = path.join(tmp, "stack.plist");
	fs.writeFileSync(stateFile, JSON.stringify({ previewRef: "feat/x", phase: "switching" }));
	fs.writeFileSync(plist, "<plist/>");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** launchctl, sleep and health are stubs; `bootstrapResults` is consumed one per bootstrap call (then repeats the last). */
const sw = (o: { bootstrapResults?: number[]; healthy?: boolean; okPhase?: string; clear?: boolean } = {}) => {
	const calls: string[] = [];
	const logs: string[] = [];
	const results = [...(o.bootstrapResults ?? [0])];
	const launchctl = (...args: string[]) => {
		calls.push(args[0]);
		if (args[0] === "bootstrap") return results.length > 1 ? results.shift() : results[0];
		return 0;
	};
	const run = () =>
		runSwitch({
			stateFile, plist, label: "com.wolfpack.stack", port: "7141", okPhase: o.okPhase ?? "running", clear: o.clear ?? false, uid: 501,
			launchctl, sleep: async () => {}, health: async () => o.healthy ?? true, log: (m: string) => logs.push(m),
		});
	return { calls, logs, run };
};
const phase = () => JSON.parse(fs.readFileSync(stateFile, "utf8")).phase;

describe("runtime-preview-switch", () => {
	it("a missing plist aborts before bootout, so nothing is stopped", async () => {
		fs.rmSync(plist);
		const s = sw();
		expect(await s.run()).toBe(1);
		expect(s.calls).toEqual([]);
		expect(phase()).toBe("plist-missing");
		expect(s.logs.join("\n")).toContain(plist);
	});

	it("retries bootstrap after launchd was slow to unload, then reports running", async () => {
		const s = sw({ bootstrapResults: [5, 5, 0] });
		expect(await s.run()).toBe(0);
		expect(s.calls).toEqual(["bootout", "bootstrap", "bootstrap", "bootstrap"]);
		expect(phase()).toBe("running");
	});

	it("when bootstrap never works it records stack-down and logs the recovery command", async () => {
		const s = sw({ bootstrapResults: [5] });
		expect(await s.run()).toBe(1);
		expect(s.calls.filter((c) => c === "bootstrap")).toHaveLength(5);
		expect(phase()).toBe("stack-down");
		const out = s.logs.join("\n");
		expect(out).toContain(`launchctl bootstrap gui/501 ${plist}`);
		expect(out).toContain("Manual way back");
	});

	it("healthz never answering after a good bootstrap is unhealthy, and the stack stays bootstrapped", async () => {
		const s = sw({ healthy: false });
		expect(await s.run()).toBe(1);
		expect(phase()).toBe("unhealthy");
		expect(s.calls).toEqual(["bootout", "bootstrap"]); // no second bootout: the stack was left up
	});

	it("clear removes the state file once healthy", async () => {
		const s = sw({ clear: true });
		expect(await s.run()).toBe(0);
		expect(fs.existsSync(stateFile)).toBe(false);
	});
});
