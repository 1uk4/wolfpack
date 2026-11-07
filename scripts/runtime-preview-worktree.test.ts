import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { runPreview } from "./runtime-preview.mjs";

let tmp: string, home: string, main: string, rt: string, wtA: string, wtB: string;
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const stateFile = () => path.join(home, ".wolfpack", "preview", "state.json");
const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));
const plistFile = () => path.join(home, "Library", "LaunchAgents", "com.wolfpack.stack.plist");
const ud = () => path.join(tmp, "Application Support");
/** The stack plist as launchd has it: caffeinate under a shell, run from the runtime checkout. */
const stackPlist = (dir: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
	<key>Label</key><string>com.wolfpack.stack</string>
	<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>exec caffeinate -i /usr/bin/node ${dir}/packages/workerd/dist/bin/workerd.js</string></array>
	<key>WorkingDirectory</key><string>${dir}</string>
	<key>KeepAlive</key><true/>
</dict></plist>
`;
/** Make a worktree look built: workerd entry, and a fake next for the live console. */
const markBuilt = (d: string) => {
	fs.mkdirSync(path.join(d, "packages", "workerd", "dist", "bin"), { recursive: true });
	fs.writeFileSync(path.join(d, "packages", "workerd", "dist", "bin", "workerd.js"), "//");
	fs.mkdirSync(path.join(d, "apps", "console", "node_modules", "next", "dist", "bin"), { recursive: true });
	fs.writeFileSync(path.join(d, "apps", "console", "node_modules", "next", "dist", "bin", "next"), "//");
};

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rtwt-")));
	home = path.join(tmp, "home");
	fs.mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
	fs.mkdirSync(path.join(ud(), "LearnHarness"), { recursive: true });
	fs.writeFileSync(path.join(ud(), "LearnHarness", "console.json"), JSON.stringify({ consoleUrl: "https://sfo-01.example" }));
	main = path.join(tmp, "main");
	g(tmp, "init", "-q", "-b", "main", main);
	g(main, "config", "user.email", "t@t");
	g(main, "config", "user.name", "t");
	fs.writeFileSync(path.join(main, "a.txt"), "a");
	g(main, "add", "a.txt");
	g(main, "commit", "-q", "-m", "a");
	rt = path.join(tmp, "rt");
	wtA = path.join(tmp, "wt-a");
	wtB = path.join(tmp, "wt-b");
	g(main, "worktree", "add", "-q", "-b", "stable", rt);
	g(main, "worktree", "add", "-q", "-b", "feat/a", wtA);
	g(main, "worktree", "add", "-q", "-b", "feat/b", wtB);
	markBuilt(wtA);
	markBuilt(wtB);
	fs.writeFileSync(plistFile(), stackPlist(rt));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const harness = (o: { confirm?: boolean | "none" } = {}) => {
	const flags = { portBusy: false };
	const lc: string[][] = [];
	const helper: string[] = [];
	const asked: string[] = [];
	const logs: string[] = [];
	const steps: Record<string, unknown> = {
		launchctl: (...a: string[]) => (lc.push(a), 0),
		sleep: async () => {},
		portFree: async () => !flags.portBusy,
		fetchJson: async () => ({ wolves: [{ id: "x", name: "1uk4" }], chats: [] }),
		spawnHelper: (a: { args: string[] }) => helper.push(a.args.slice(4).join(" ")),
	};
	if (o.confirm !== "none") steps.confirm = async (q: string) => (asked.push(q), o.confirm ?? true);
	const run = (argv: string[], cwd = main) =>
		runPreview({ argv, env: { HOME: home, PREVIEW_USERDATA_ROOT: ud() }, cwd, steps, log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) });
	return { run, lc, helper, asked, logs, flags };
};

describe("worktree preview: the wolves run straight from a built worktree", () => {
	it("rewrites the stack plist to the worktree, serves the live console from it and hands over to the helper after one confirm", async () => {
		const h = harness();
		const r = await h.run([wtA]);
		expect(r.exitCode).toBe(0);
		expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(wtA));
		expect(h.asked.length).toBe(1);
		expect(h.helper).toEqual(["running 0"]);
		expect(readState()).toMatchObject({ mode: "worktree", worktree: wtA, previewRef: "feat/a", console: { mode: "dev", dir: wtA }, phase: "switching" });
		expect(h.lc.some((a) => a[0] === "bootstrap" && a[2].endsWith("com.wolfpack.preview-console.plist"))).toBe(true);
		expect(g(rt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("stable"); // the runtime checkout is not touched
	});

	it("a refused confirm, or no terminal without --yes, changes nothing; --yes skips the question", async () => {
		const before = stackPlist(rt);
		const no = harness({ confirm: false });
		expect((await no.run([wtA])).exitCode).toBe(1);
		const tty = harness({ confirm: "none" });
		expect((await tty.run([wtA])).exitCode).toBe(1);
		for (const h of [no, tty]) expect(h.helper).toEqual([]);
		expect(fs.readFileSync(plistFile(), "utf8")).toBe(before);
		expect(fs.existsSync(stateFile())).toBe(false);
		const yes = harness({ confirm: "none" });
		expect((await yes.run([wtA, "--yes"])).exitCode).toBe(0);
		expect(yes.helper).toEqual(["running 0"]);
	});

	it("switching to another worktree keeps the first plist as the original, and off restores its bytes exactly", async () => {
		const original = fs.readFileSync(plistFile());
		const h = harness();
		await h.run([wtA]);
		await h.run([wtB]);
		expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(wtB));
		h.helper.length = 0;
		const r = await h.run(["off", "--all"]);
		expect(r.exitCode).toBe(0);
		expect(fs.readFileSync(plistFile()).equals(original)).toBe(true);
		expect(h.helper).toEqual(["stable 1"]);
	});

	it("off --rollback (used by the helper) restores the plist without a helper and keeps the state", async () => {
		const original = fs.readFileSync(plistFile());
		const h = harness();
		await h.run([wtA]);
		h.helper.length = 0;
		expect((await h.run(["off", "--rollback"])).exitCode).toBe(0);
		expect(fs.readFileSync(plistFile()).equals(original)).toBe(true);
		expect(h.helper).toEqual([]);
		expect(readState().mode).toBe("worktree");
	});

	it("a worktree deleted while active is flagged by status, and off still restores the plist", async () => {
		const original = fs.readFileSync(plistFile());
		const h = harness();
		await h.run([wtA]);
		fs.rmSync(wtA, { recursive: true, force: true });
		h.logs.length = 0;
		await h.run(["status", "--json"]);
		expect(JSON.parse(h.logs.join("\n")).worktreeMissing).toBe(true);
		expect((await h.run(["off", "--all"])).exitCode).toBe(0);
		expect(fs.readFileSync(plistFile()).equals(original)).toBe(true);
	});

	it("a failed start after a dev-only preview restores the plist bytes, keeps the dev state without a plist and brings the dev console back", async () => {
		const original = fs.readFileSync(plistFile());
		const h = harness();
		await h.run(["dev", wtB]);
		const before = readState();
		h.flags.portBusy = true;
		h.lc.length = 0;
		expect((await h.run([wtA])).exitCode).toBe(1);
		expect(fs.readFileSync(plistFile()).equals(original)).toBe(true);
		expect(readState()).toEqual(before);
		expect("plist" in readState()).toBe(false);
		const boot = h.lc.filter((a) => a[0] === "bootstrap" && a[2].endsWith("com.wolfpack.preview-console.plist"));
		expect(boot.length).toBe(1);
		expect(fs.readFileSync(path.join(home, "Library", "LaunchAgents", "com.wolfpack.preview-console.plist"), "utf8")).toContain(wtB);
	});

	it("refuses a worktree that is not built, changing nothing", async () => {
		fs.rmSync(path.join(wtA, "packages"), { recursive: true });
		const h = harness();
		expect((await h.run([wtA])).exitCode).toBe(1);
		expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(rt));
		expect(fs.existsSync(stateFile())).toBe(false);
	});
});
