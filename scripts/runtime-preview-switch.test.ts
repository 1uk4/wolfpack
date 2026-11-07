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
type Json = unknown;
const sw = (o: { bootstrapResults?: number[]; healthy?: boolean; okPhase?: string; clear?: boolean; deep?: { consoleUrl: string; fetchJson: (url: string) => Promise<Json>; rollback: () => Promise<boolean> } } = {}) => {
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
			launchctl, sleep: async () => {}, health: async () => o.healthy ?? true, log: (m: string) => logs.push(m), ...(o.deep ? { deep: { consoleUrl: o.deep.consoleUrl }, fetchJson: o.deep.fetchJson, rollback: o.deep.rollback } : {}),
		});
	return { calls, logs, run };
};
const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
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

	describe("deep health", () => {
		const good = async (url: string): Promise<Json> => (url.endsWith("/api/wolves") ? { wolves: [{ name: "w" }] } : { chats: [] });
		const deep = (fetchJson: (u: string) => Promise<Json>, rollback = async () => true) => ({ consoleUrl: "http://127.0.0.1:3230", fetchJson, rollback });

		it("a console that lists a wolf and a chat list passes and ends in the ok phase", async () => {
			const s = sw({ deep: deep(good) });
			expect(await s.run()).toBe(0);
			expect(phase()).toBe("running");
		});

		it("an empty wolf list rolls back: rollback runs, the stack restarts, and the state ends rolled-back with the reason", async () => {
			let rolled = 0;
			const s = sw({ deep: deep(async (u) => (u.endsWith("/api/wolves") ? { wolves: [] } : { chats: [] }), async () => (rolled++, true)) });
			expect(await s.run()).toBe(1);
			expect(rolled).toBe(1);
			expect(s.calls).toEqual(["bootout", "bootstrap", "bootout", "bootstrap"]);
			expect(state()).toMatchObject({ phase: "rolled-back", reason: expect.stringContaining("/api/wolves") });
		});

		it("a rollback that fails ends stack-down with the manual way back", async () => {
			const s = sw({ deep: deep(async () => { throw new Error("down"); }, async () => false) });
			expect(await s.run()).toBe(1);
			expect(phase()).toBe("stack-down");
			expect(s.logs.join("\n")).toContain("Manual way back");
		});

		it("a console that is down while wolfd answers is reported as such, and still rolls back", async () => {
			const s = sw({ deep: deep(async (u) => { if (u.includes("3230")) throw new Error("ECONNREFUSED"); return { wolves: [{ name: "w" }] }; }) });
			expect(await s.run()).toBe(1);
			expect(state()).toMatchObject({ phase: "rolled-back", reason: expect.stringContaining("wolfd answers") });
		});
	});
});
