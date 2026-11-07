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
type Local = { keepConsole?: boolean; port: string; home: string; userDataRoot: string; runtimeDir: string; node: string };
const sw = (o: { bootstrapResults?: number[]; healthy?: boolean; okPhase?: string; clear?: boolean; deep?: { consoleUrl: string; fetchJson: (url: string) => Promise<Json>; rollback: () => Promise<boolean> }; local?: Local; portFree?: boolean } = {}) => {
	const full: string[][] = [];
	const calls: string[] = [];
	const logs: string[] = [];
	const results = [...(o.bootstrapResults ?? [0])];
	const launchctl = (...args: string[]) => {
		calls.push(args[0]);
		full.push(args);
		if (args[0] === "bootstrap") return results.length > 1 ? results.shift() : results[0];
		return 0;
	};
	const run = () =>
		runSwitch({
			stateFile, plist, label: "com.wolfpack.stack", port: "7141", okPhase: o.okPhase ?? "running", clear: o.clear ?? false, uid: 501,
			launchctl, sleep: async () => {}, health: async () => o.healthy ?? true, log: (m: string) => logs.push(m), ...(o.deep ? { deep: { consoleUrl: o.deep.consoleUrl }, fetchJson: o.deep.fetchJson, rollback: o.deep.rollback } : {}), ...(o.local ? { localConsole: o.local } : {}), portFree: async () => o.portFree ?? true,
		});
	return { calls, logs, run, full };
};
/** Outputs captured from the live console. */
const realConsole = async (url: string): Promise<Json> =>
	url.endsWith("/api/wolves")
		? { wolves: [{ id: "ddkyhT", name: "1uk4", host: "local", status: "busy", librarian: false, kbReadable: true }] }
		: { chats: [{ id: "chat_1", title: "t", createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z", version: 1, messageCount: 0, pendingQuestion: false, busy: false, compacting: false }] };
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

	it("for a worktree preview the manual way back restores the saved plist and never mentions the runtime checkout", async () => {
		fs.writeFileSync(stateFile, JSON.stringify({ previewRef: "feat/x", mode: "worktree", phase: "switching" }));
		const s = sw({ bootstrapResults: [5] });
		await s.run();
		const out = s.logs.join("\n");
		expect(out).toContain("cp ~/.wolfpack/preview/stack.plist.orig ~/Library/LaunchAgents/com.wolfpack.stack.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wolfpack.stack.plist");
		expect(out).not.toContain("git checkout stable");
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
		const good = realConsole;
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
			const out = s.logs.join("\n");
			expect(out).toContain("Manual way back");
			expect(out).toContain("still running the preview build");
			expect(out).not.toContain("Recover with: launchctl bootstrap");
		});

		it("a console that is down while wolfd answers is reported as such, and still rolls back", async () => {
			const s = sw({ deep: deep(async (u) => { if (u.includes("3230")) throw new Error("ECONNREFUSED"); return { wolves: [{ name: "w" }] }; }) });
			expect(await s.run()).toBe(1);
			expect(state()).toMatchObject({ phase: "rolled-back", reason: expect.stringContaining("wolfd answers") });
		});
	});

	describe("local console and app pointing", () => {
		let local: Local, ud: string;
		const read = (name: string) => JSON.parse(fs.readFileSync(path.join(ud, name, "console.json"), "utf8"));
		const okDeep = (rollback = async () => true) => ({
			consoleUrl: "http://127.0.0.1:3230",
			fetchJson: realConsole,
			rollback,
		});
		beforeEach(() => {
			ud = path.join(tmp, "Application Support");
			const server = path.join(tmp, "rt", "apps", "console", ".next", "standalone", "apps", "console");
			fs.mkdirSync(server, { recursive: true });
			fs.writeFileSync(path.join(server, "server.js"), "// fake");
			fs.mkdirSync(path.join(tmp, "rt", "apps", "console", ".next", "static"), { recursive: true });
			fs.writeFileSync(path.join(tmp, "rt", "apps", "console", ".next", "static", "a.js"), "a");
			fs.mkdirSync(path.join(tmp, "rt", "apps", "console", "public"), { recursive: true });
			fs.mkdirSync(path.join(ud, "LearnHarness"), { recursive: true });
			fs.writeFileSync(path.join(ud, "LearnHarness", "console.json"), JSON.stringify({ consoleUrl: "https://sfo-01.example", theme: "dark" }));
			fs.mkdirSync(path.join(ud, "Wolfpack Console"), { recursive: true }); // exists, but has no console.json
			local = { port: "3230", home: path.join(tmp, "home"), userDataRoot: ud, runtimeDir: path.join(tmp, "rt"), node: "/usr/bin/node" };
		});

		it("a good switch serves the preview console under launchd and points both app folders at it, keeping other keys", async () => {
			const s = sw({ deep: okDeep(), local });
			expect(await s.run()).toBe(0);
			const plistPath = path.join(local.home, "Library", "LaunchAgents", "com.wolfpack.preview-console.plist");
			const text = fs.readFileSync(plistPath, "utf8");
			expect(text).toContain("<string>http://127.0.0.1:7141</string>");
			expect(text).toContain("apps/console/server.js");
			expect(s.full).toContainEqual(["bootstrap", `gui/501`, plistPath]);
			expect(fs.existsSync(path.join(tmp, "rt", "apps", "console", ".next", "standalone", "apps", "console", ".next", "static", "a.js"))).toBe(true);
			expect(read("LearnHarness")).toEqual({ consoleUrl: "http://127.0.0.1:3230", theme: "dark" });
			expect(read("Wolfpack Console")).toEqual({ consoleUrl: "http://127.0.0.1:3230" });
		});

		it("off restores each console.json exactly, removes the key where there was none, and stops the console", async () => {
			await sw({ deep: okDeep(), local }).run();
			const off = sw({ clear: true, local });
			expect(await off.run()).toBe(0);
			expect(read("LearnHarness")).toEqual({ consoleUrl: "https://sfo-01.example", theme: "dark" });
			expect(fs.existsSync(path.join(ud, "Wolfpack Console", "console.json"))).toBe(false);
			expect(off.full).toContainEqual(["bootout", "gui/501/com.wolfpack.preview-console"]);
		});

		it("with a dev console active (keepConsole) a ref switch neither starts, stops nor re-points the console", async () => {
			const s = sw({ deep: okDeep(), local: { ...local, keepConsole: true } });
			expect(await s.run()).toBe(0);
			expect(s.full.some((a) => String(a[1] ?? "").includes("preview-console") || String(a[2] ?? "").includes("preview-console"))).toBe(false);
			expect(read("LearnHarness")).toEqual({ consoleUrl: "https://sfo-01.example", theme: "dark" });
		});

		it("a failed deep check leaves console.json untouched and stops the console before rolling back", async () => {
			const s = sw({ deep: { ...okDeep(), fetchJson: async () => ({ wolves: [] }) }, local });
			expect(await s.run()).toBe(1);
			expect(read("LearnHarness")).toEqual({ consoleUrl: "https://sfo-01.example", theme: "dark" });
			expect(fs.existsSync(path.join(ud, "Wolfpack Console", "console.json"))).toBe(false);
			expect(s.full).toContainEqual(["bootout", "gui/501/com.wolfpack.preview-console"]);
			expect(phase()).toBe("rolled-back");
		});

		it("off after a crash between pointing the files and writing state restores the original from the backup", async () => {
			const file = path.join(ud, "LearnHarness", "console.json");
			fs.copyFileSync(file, `${file}.preview-backup`);
			fs.writeFileSync(file, JSON.stringify({ consoleUrl: "http://127.0.0.1:3230", theme: "dark" })); // pointed, but state has no apps
			expect(await sw({ clear: true, local }).run()).toBe(0);
			expect(read("LearnHarness")).toEqual({ consoleUrl: "https://sfo-01.example", theme: "dark" });
		});

		it("a new on after that crash never records the preview url as the original", async () => {
			const file = path.join(ud, "LearnHarness", "console.json");
			fs.copyFileSync(file, `${file}.preview-backup`);
			fs.writeFileSync(file, JSON.stringify({ consoleUrl: "http://127.0.0.1:3230", theme: "dark" }));
			expect(await sw({ deep: okDeep(), local }).run()).toBe(0);
			expect(state().apps.find((a: { file: string }) => a.file === file).previous).toBe("https://sfo-01.example");
			expect(await sw({ clear: true, local }).run()).toBe(0);
			expect(read("LearnHarness").consoleUrl).toBe("https://sfo-01.example");
		});

		it("state gets apps before any console.json is touched, and a failed apps write fails loudly", async () => {
			fs.chmodSync(stateFile, 0o444);
			await expect(sw({ deep: okDeep(), local }).run()).rejects.toThrow();
			expect(read("LearnHarness")).toEqual({ consoleUrl: "https://sfo-01.example", theme: "dark" });
			expect(fs.existsSync(path.join(ud, "Wolfpack Console", "console.json"))).toBe(false);
		});

		it("a busy console port fails the preview with the reason, starts no console and rolls back", async () => {
			const s = sw({ deep: okDeep(), local, portFree: false });
			expect(await s.run()).toBe(1);
			expect(state()).toMatchObject({ phase: "rolled-back", reason: expect.stringContaining("3230") });
			expect(s.full.some((a) => a[0] === "bootstrap" && String(a[2]).includes("preview-console"))).toBe(false);
			expect(read("LearnHarness").consoleUrl).toBe("https://sfo-01.example");
		});

		it("healthz never answering on off still stops the console and restores the apps", async () => {
			await sw({ deep: okDeep(), local }).run();
			const off = sw({ clear: true, local, healthy: false });
			expect(await off.run()).toBe(1);
			expect(read("LearnHarness").consoleUrl).toBe("https://sfo-01.example");
			expect(off.full).toContainEqual(["bootout", "gui/501/com.wolfpack.preview-console"]);
		});
	});
});
