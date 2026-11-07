import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { runPreview } from "./runtime-preview.mjs";
// @ts-expect-error plain .mjs script
import { pickerModel } from "./runtime-preview-worktree.mjs";

const fallbackDir = () => path.join(tmp, "picker-checkout");
const oldCli = (d: string) => fs.writeFileSync(path.join(d, "packages", "cli", "dist", "commands", "preview.js"), "export async function previewCmd() {}\n"); // the task 1 version
const cliLink = () => path.join(tmp, "global", "node_modules", "@wolfpack", "cli");
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
	fs.mkdirSync(path.join(d, "packages", "cli", "dist", "bin"), { recursive: true });
	fs.writeFileSync(path.join(d, "packages", "cli", "dist", "bin", "wolfpack.js"), "//");
	fs.mkdirSync(path.join(d, "packages", "cli", "dist", "commands"), { recursive: true });
	fs.writeFileSync(path.join(d, "packages", "cli", "dist", "commands", "preview.js"), "export const PREVIEW_CLI = 1; // bin copy aware\n");
	fs.mkdirSync(path.join(d, "node_modules", "typescript", "bin"), { recursive: true });
	fs.writeFileSync(path.join(d, "node_modules", "typescript", "bin", "tsc"), "//");
	fs.writeFileSync(path.join(d, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "packages/a" }] }));
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
	fs.mkdirSync(path.dirname(cliLink()), { recursive: true });
	fs.mkdirSync(path.join(rt, "packages", "cli"), { recursive: true });
	fs.symlinkSync(path.join(rt, "packages", "cli"), cliLink()); // the global `wolfpack`: a link to the runtime's cli
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Item = { label: string; value: unknown };
const harness = (o: { confirm?: boolean | "none"; pick?: (items: Item[]) => unknown } = {}) => {
	const builds: { dir: string; logFile?: string }[] = [];
	const menus: Item[][] = [];
	const flags = { portBusy: false };
	const lc: string[][] = [];
	const helper: string[] = [];
	const asked: string[] = [];
	const logs: string[] = [];
	const steps: Record<string, unknown> = {
		launchctl: (...a: string[]) => (lc.push(a), 0),
		sleep: async () => {},
		cliLink: () => cliLink(),
		cliFallbackDir: () => fallbackDir(),
		portFree: async () => !flags.portBusy,
		fetchJson: async () => ({ wolves: [{ id: "x", name: "1uk4" }], chats: [] }),
		build: (dir: string, b?: { logFile?: string }) => (builds.push({ dir, logFile: b?.logFile }), markBuilt(dir)),
		health: async () => true,
		pick: async (_title: string, items: Item[]) => (menus.push(items), o.pick ? o.pick(items) : null),
		spawnHelper: (a: { args: string[] }) => helper.push(a.args.slice(4).join(" ")),
	};
	if (o.confirm !== "none") steps.confirm = async (q: string) => (asked.push(q), o.confirm ?? true);
	const run = (argv: string[], cwd = main) =>
		runPreview({ argv, env: { HOME: home, PREVIEW_USERDATA_ROOT: ud() }, cwd, steps, log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) });
	return { run, lc, helper, asked, logs, builds, menus, flags };
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

	it("the global wolfpack cli follows the worktree: record, repoint, keep the original through a switch, restore on off and rollback", async () => {
		const runtimeCli = path.join(rt, "packages", "cli");
		const h = harness();
		await h.run([wtA]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(wtA, "packages", "cli"));
		expect(readState().cli).toMatchObject({ link: cliLink(), target: runtimeCli });
		await h.run([wtB]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(wtB, "packages", "cli"));
		expect(readState().cli.target).toBe(runtimeCli);
		await h.run(["off", "--rollback"]);
		expect(fs.readlinkSync(cliLink())).toBe(runtimeCli);
		await h.run(["off", "--all"]);
		expect(fs.readlinkSync(cliLink())).toBe(runtimeCli);
		await h.run([wtA]);
		await h.run(["off", "--console"]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(wtA, "packages", "cli")); // console-only leaves it
		await h.run(["off", "--all"]);
		expect(fs.readlinkSync(cliLink())).toBe(runtimeCli);
	});

	it("a worktree whose cli predates the bin copy is not linked: the picker checkout's cli is, with a line saying so; restore is exact", async () => {
		const runtimeCli = path.join(rt, "packages", "cli");
		oldCli(wtA);
		markBuilt(fallbackDir());
		const h = harness();
		await h.run([wtA]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(fallbackDir(), "packages", "cli"));
		expect(h.logs.join("\n")).toContain(`wolfpack CLI from ${fallbackDir()} (the previewed worktree's CLI predates preview)`);
		await h.run([wtB]); // compatible: used directly
		expect(fs.readlinkSync(cliLink())).toBe(path.join(wtB, "packages", "cli"));
		oldCli(wtB);
		await h.run([wtA]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(fallbackDir(), "packages", "cli"));
		await h.run(["off", "--all"]);
		expect(fs.readlinkSync(cliLink())).toBe(runtimeCli);
	});

	it("when neither the worktree's cli nor the picker checkout's is compatible the link is left alone and the node bin fallback is printed", async () => {
		oldCli(wtA);
		fs.mkdirSync(path.join(fallbackDir(), "packages", "cli"), { recursive: true });
		const h = harness();
		expect((await h.run([wtA])).exitCode).toBe(0);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(rt, "packages", "cli"));
		expect(readState().cli).toBeUndefined();
		expect(h.logs.join("\n")).toContain("node ~/.wolfpack/preview/bin/runtime-preview.mjs");
	});

	it("a failed start leaves the cli link on its original target", async () => {
		const h = harness();
		await h.run(["dev", wtB]);
		h.flags.portBusy = true;
		expect((await h.run([wtA])).exitCode).toBe(1);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(rt, "packages", "cli"));
	});

	it("a global cli that is a real install, not a link, is left untouched with a warning naming the bin fallback", async () => {
		fs.rmSync(cliLink());
		fs.mkdirSync(cliLink());
		fs.writeFileSync(path.join(cliLink(), "marker"), "x");
		const h = harness();
		expect((await h.run([wtA])).exitCode).toBe(0);
		expect(fs.lstatSync(cliLink()).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(path.join(cliLink(), "marker"), "utf8")).toBe("x");
		expect(readState().cli).toBeUndefined();
		expect(h.logs.join("\n")).toContain("node ~/.wolfpack/preview/bin/runtime-preview.mjs");
		await h.run(["off", "--all"]);
		expect(fs.readFileSync(path.join(cliLink(), "marker"), "utf8")).toBe("x");
	});

	it("a worktree deleted while active is flagged by status, and off still restores the plist", async () => {
		const original = fs.readFileSync(plistFile());
		const h = harness();
		await h.run([wtA]);
		fs.rmSync(wtA, { recursive: true, force: true });
		h.logs.length = 0;
		await h.run(["status", "--json"]);
		expect(JSON.parse(h.logs.join("\n")).worktreeMissing).toBe(true);
		h.logs.length = 0;
		await h.run(["status"]);
		expect(h.logs.join("\n")).toContain("node ~/.wolfpack/preview/bin/runtime-preview.mjs off --all");
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

	describe("picker", () => {
		const labels = (h: ReturnType<typeof harness>) => h.menus[0].map((i) => i.label);
		const commit = (d: string, f: string) => {
			fs.writeFileSync(path.join(d, f), f);
			g(d, "add", f);
			g(d, "commit", "-q", "-m", f);
		};
		/** A: built (stamped) with an edit. B: built, then a new commit (stale). C: a never-built branch with a commit. W: a worker's copy with a commit. */
		const setup = async () => {
			const c = path.join(tmp, "wt-c");
			const w = path.join(tmp, "wt-c--detach-chat-12ab34cd");
			g(main, "worktree", "add", "-q", "-b", "feat/yu741qH-floating-chat-bar-talk-to-one", c);
			g(main, "worktree", "add", "-q", "-b", "feat/w", w);
			commit(c, "c.txt");
			commit(w, "w.txt");
			const h = harness();
			await h.run([wtB, "--build"]);
			await h.run(["off", "--all"]);
			commit(wtB, "b.txt");
			commit(wtA, "a.txt");
			await h.run([wtA, "--build"]);
			fs.writeFileSync(path.join(wtA, "a.txt"), "edited");
			await h.run(["off", "--all"]);
			return h;
		};

		it("shows one short line per worktree (name, status mark, no paths), hides stable and the main checkout, and offers Show all at the bottom", async () => {
			const h = await setup();
			h.menus.length = 0;
			await h.run([], wtB);
			const l = labels(h);
			expect(l).toContain("yu741qH-floating-chat…  ○ not built");
			expect(l).toContain("detach-chat (worker)  ○ not built");
			expect(l.some((x) => x.startsWith("stable") || x.startsWith("main"))).toBe(false);
			expect(l.every((x) => !x.includes(tmp))).toBe(true);
			expect(l.at(-1)).toBe("Show all worktrees…");
			expect(l.length).toBe(5); // a, b, c, worker, Show all
		});

		it("Show all worktrees lists the hidden ones too", async () => {
			const h = await setup();
			const h2 = harness({ pick: (items) => (items.some((i) => i.label === "Show all worktrees…") && h2.menus.length === 1 ? "all" : null) });
			h2.menus.length = 0;
			await h2.run([], wtB);
			expect(h2.menus.length).toBe(2);
			expect(h2.menus[1].map((i) => i.label).some((x) => x.startsWith("stable"))).toBe(true);
			expect(h2.menus[1].map((i) => i.label).some((x) => x.startsWith("main"))).toBe(true);
		});

		it("without a terminal prints the list and exits 1", async () => {
			const h = await setup();
			h.logs.length = 0;
			expect((await h.run([])).exitCode).toBe(1);
			expect(h.logs.join("\n")).toContain("◐ stale");
		});

		it("picking a not-built row builds it first, with output in last-run.log, then starts its preview", async () => {
			const h = await setup();
			const h2 = harness({ pick: (items) => items.find((i) => i.label.startsWith("yu741qH"))?.value });
			expect((await h2.run([], wtB)).exitCode).toBe(0);
			expect(h2.builds.map((b) => b.dir)).toEqual([path.join(tmp, "wt-c")]);
			expect(h2.builds[0].logFile).toBe(path.join(home, ".wolfpack", "preview", "last-run.log"));
			expect(h2.helper).toEqual(["running 0"]);
			void h;
		});

		it("picking a built row starts it without building", async () => {
			await setup();
			fs.writeFileSync(path.join(wtA, "a.txt"), "a.txt"); // undo the edit: built again
			const h2 = harness({ pick: (items) => items.find((i) => i.label.includes("● built"))?.value });
			expect((await h2.run([], wtB)).exitCode).toBe(0);
			expect(h2.builds).toEqual([]);
			expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(wtA));
		});
	});

	describe("picker row model", () => {
		type W = { dir: string; branch: string | null; status: string; dirty?: boolean; commitTime: number; merged?: boolean; main?: boolean };
		const wt = (o: W) => ({ dirty: false, merged: false, main: false, ...o });
		const model = (worktrees: ReturnType<typeof wt>[], o: { here?: string; activeDir?: string; showAll?: boolean } = {}) =>
			pickerModel({ worktrees, runtimeBranch: "stable", ...o });

		it("names a branch without feat/ and the slug tail, and a worker's copy by its worker name", () => {
			const { rows } = model([
				wt({ dir: "/w/feat-yu741qH-floating-chat-bar-talk-to-one", branch: "feat/yu741qH-floating-chat-bar-talk-to-one", status: "built", commitTime: 5 }),
				wt({ dir: "/w/feat-yu741qH-x--detach-chat-30b2c6aa", branch: "feat/yu741qH-x--detach-chat-30b2c6aa", status: "stale", commitTime: 4 }),
				wt({ dir: "/w/fix", branch: "fix/short", status: "not built", commitTime: 3 }),
			]);
			expect(rows.map((r: { name: string }) => r.name)).toEqual(["yu741qH-floating-chat…", "detach-chat (worker)", "fix/short"]);
		});

		it("hides stable, the main checkout, detached heads and clean merged branches, unless active or the cwd's; showAll hides nothing", () => {
			const all = [
				wt({ dir: "/rt", branch: "stable", status: "built", commitTime: 9 }),
				wt({ dir: "/main", branch: "main", status: "built", commitTime: 9, main: true }),
				wt({ dir: "/det", branch: null, status: "built", commitTime: 9 }),
				wt({ dir: "/merged", branch: "feat/m", status: "built", commitTime: 9, merged: true }),
				wt({ dir: "/merged-edit", branch: "feat/me", status: "built", commitTime: 8, merged: true, dirty: true }),
				wt({ dir: "/merged-here", branch: "feat/mh", status: "built", commitTime: 7, merged: true }),
				wt({ dir: "/merged-active", branch: "feat/ma", status: "built", commitTime: 6, merged: true }),
				wt({ dir: "/live", branch: "feat/live", status: "not built", commitTime: 5 }),
			];
			const r = model(all, { here: "/merged-here", activeDir: "/merged-active" });
			expect(r.rows.map((x: { dir: string }) => x.dir)).toEqual(["/merged-active", "/merged-here", "/merged-edit", "/live"]);
			expect(r.hiddenCount).toBe(4);
			expect(model(all, { showAll: true }).rows.length).toBe(8);
		});

		it("orders active first, then the cwd's worktree, then newest commit first", () => {
			const { rows } = model(
				[
					wt({ dir: "/old", branch: "feat/old", status: "built", commitTime: 1 }),
					wt({ dir: "/new", branch: "feat/new", status: "built", commitTime: 9 }),
					wt({ dir: "/here", branch: "feat/here", status: "built", commitTime: 2 }),
					wt({ dir: "/act", branch: "feat/act", status: "built", commitTime: 0 }),
				],
				{ here: "/here", activeDir: "/act" },
			);
			expect(rows.map((r: { dir: string }) => r.dir)).toEqual(["/act", "/here", "/new", "/old"]);
		});

		it("marks status with ● built, ◐ stale, ○ not built, plus active, and says unbuilt rows build first", () => {
			const { rows } = model(
				[
					wt({ dir: "/a", branch: "feat/a", status: "built", commitTime: 3 }),
					wt({ dir: "/b", branch: "feat/b", status: "stale", commitTime: 2 }),
					wt({ dir: "/c", branch: "feat/c", status: "not built", commitTime: 1 }),
				],
				{ activeDir: "/a" },
			);
			expect(rows.map((r: { label: string }) => r.label)).toEqual(["a  ● built  active", "b  ◐ stale", "c  ○ not built"]);
			expect(rows[1].hint).toContain("builds first");
			expect(rows[0].hint).not.toContain("builds first");
		});
	});

	describe("build status without a stamp", () => {
		it("a worktree whose workerd and cli dist are newer than its HEAD commit counts as built; older dist counts as not built", async () => {
			const h = harness({ pick: () => null });
			h.menus.length = 0;
			await h.run([], wtA); // markBuilt just wrote dist files after the commit
			expect(h.logs.join("\n")).toContain("a  ● built");
			const old = new Date(Date.now() - 86_400_000 * 365);
			for (const f of [path.join(wtA, "packages", "workerd", "dist", "bin", "workerd.js"), path.join(wtA, "packages", "cli", "dist", "bin", "wolfpack.js")]) fs.utimesSync(f, old, old);
			h.logs.length = 0;
			await h.run([], wtA);
			expect(h.logs.join("\n")).toContain("a  ○ not built");
		});
	});

	describe("backend rebuilds while a preview runs", () => {
		const watchPlist = () => path.join(home, "Library", "LaunchAgents", "com.wolfpack.preview-watch.plist");
		const watchJson = () => path.join(home, ".wolfpack", "preview", "watch.json");
		const status = async (h: ReturnType<typeof harness>) => {
			h.logs.length = 0;
			await h.run(["status", "--json"]);
			return JSON.parse(h.logs.join("\n"));
		};

		it("starts a watch agent that rebuilds the worktree and logs to watch.log, and off stops it", async () => {
			const h = harness();
			await h.run([wtA]);
			const text = fs.readFileSync(watchPlist(), "utf8");
			expect(text).toContain(wtA);
			expect(text).toContain(path.join(home, ".wolfpack", "preview", "watch.log"));
			expect(h.lc.some((a) => a[0] === "bootstrap" && a[2] === watchPlist())).toBe(true);
			await h.run(["off", "--all"]);
			expect(h.lc.some((a) => a[0] === "bootout" && a[1].endsWith("com.wolfpack.preview-watch"))).toBe(true);
			expect(fs.existsSync(watchPlist())).toBe(false);
		});

		it("status shows restart needed once a rebuild finished after the stack started", async () => {
			const h = harness();
			await h.run([wtA]);
			const started = readState().startedAt as string;
			fs.writeFileSync(watchJson(), JSON.stringify({ lastRebuildOk: new Date(Date.parse(started) - 60_000).toISOString() }));
			expect((await status(h)).restartNeeded).toBe(false);
			fs.writeFileSync(watchJson(), JSON.stringify({ lastRebuildOk: new Date(Date.parse(started) + 60_000).toISOString() }));
			expect((await status(h)).restartNeeded).toBe(true);
			h.logs.length = 0;
			await h.run(["status"]);
			expect(h.logs.join("\n")).toContain("restart needed");
		});

		it("restart asks, then kickstarts only the stack and clears restart needed", async () => {
			await harness().run([wtA]);
			const no = harness({ confirm: false });
			fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), startedAt: new Date(Date.now() - 3_600_000).toISOString() }));
			fs.writeFileSync(watchJson(), JSON.stringify({ lastRebuildOk: new Date(Date.now() - 1_800_000).toISOString() }));
			no.lc.length = 0;
			expect((await no.run(["restart"])).exitCode).toBe(1);
			expect(no.lc).toEqual([]);
			const h = harness();
			expect((await h.run(["restart"])).exitCode).toBe(0);
			expect(h.lc).toEqual([["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/com.wolfpack.stack`]]);
			expect((await status(h)).restartNeeded).toBe(false);
		});

		it("off --rollback (used by the helper) stops the watcher too", async () => {
			const h = harness();
			await h.run([wtA]);
			h.lc.length = 0;
			expect((await h.run(["off", "--rollback"])).exitCode).toBe(0);
			expect(h.lc.some((a) => a[0] === "bootout" && a[1].endsWith("com.wolfpack.preview-watch"))).toBe(true);
			expect(fs.existsSync(watchPlist())).toBe(false);
		});

		it("a worktree without typescript or a root tsconfig with references warns and starts no watcher, the preview still starts", async () => {
			fs.rmSync(path.join(wtA, "node_modules", "typescript"), { recursive: true });
			const h = harness();
			expect((await h.run([wtA])).exitCode).toBe(0);
			expect(fs.existsSync(watchPlist())).toBe(false);
			expect(h.logs.join("\n")).toMatch(/background rebuild did not start/);
			fs.writeFileSync(path.join(wtB, "tsconfig.json"), JSON.stringify({ files: [] }));
			const h2 = harness();
			await h2.run(["off", "--all"]);
			h2.logs.length = 0;
			await h2.run([wtB]);
			expect(fs.existsSync(watchPlist())).toBe(false);
			expect(h2.logs.join("\n")).toMatch(/background rebuild did not start/);
		});

		it("the watch and console agents are throttled so a crash loop cannot spin", async () => {
			await harness().run([wtA]);
			for (const f of [watchPlist(), path.join(home, "Library", "LaunchAgents", "com.wolfpack.preview-console.plist")]) {
				expect(fs.readFileSync(f, "utf8")).toMatch(/<key>ThrottleInterval<\/key><integer>30<\/integer>/);
			}
		});

		it("restart with no preview active changes nothing", async () => {
			const h = harness();
			expect((await h.run(["restart"])).exitCode).toBe(1);
			expect(h.lc).toEqual([]);
		});
	});
	describe("off asks which part to undo", () => {
		const appUrl = () => JSON.parse(fs.readFileSync(path.join(ud(), "LearnHarness", "console.json"), "utf8")).consoleUrl;

		it("offers Live console only or Wolves too; Wolves too restores the plist and hands over to the helper", async () => {
			const h = harness({ pick: () => "all" });
			await h.run([wtA]);
			h.helper.length = 0;
			h.menus.length = 0;
			expect((await h.run(["off"])).exitCode).toBe(0);
			expect(h.menus[0].map((i) => i.label)).toEqual(["Live console only", "Wolves too"]);
			expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(rt));
			expect(h.helper).toEqual(["stable 1"]);
		});

		it("--console puts the app back on its own console and stops the live console but leaves the wolves on the worktree", async () => {
			const h = harness();
			await h.run([wtA]);
			expect(appUrl()).toBe("http://127.0.0.1:3230");
			h.helper.length = 0;
			h.menus.length = 0;
			h.lc.length = 0;
			expect((await h.run(["off", "--console"])).exitCode).toBe(0);
			expect(h.menus).toEqual([]); // the flag skips the question
			expect(appUrl()).toBe("https://sfo-01.example");
			expect(h.lc.some((a) => a[0] === "bootout" && a[1].endsWith("com.wolfpack.preview-console"))).toBe(true);
			expect(h.helper).toEqual([]);
			expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(wtA));
			expect(readState()).toMatchObject({ mode: "worktree", worktree: wtA });
			expect(readState().console).toBeUndefined();
		});

		it("without a terminal and without a flag prints the choices and exits 1, changing nothing", async () => {
			const h = harness();
			await h.run([wtA]);
			h.helper.length = 0;
			h.logs.length = 0;
			expect((await h.run(["off"])).exitCode).toBe(1);
			expect(h.logs.join("\n")).toMatch(/Live console only[\s\S]*Wolves too/);
			expect(h.helper).toEqual([]);
			expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(wtA));
		});
	});

	it("a bin copy with a higher PREVIEW_VERSION is never overwritten by an older script", async () => {
		const bin = path.join(home, ".wolfpack", "preview", "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "runtime-preview.mjs"), "export const PREVIEW_VERSION = 999;\n");
		await harness().run(["status"]);
		expect(fs.readFileSync(path.join(bin, "runtime-preview.mjs"), "utf8")).toBe("export const PREVIEW_VERSION = 999;\n");
	});

	it("copying the scripts skips an optional file that is missing instead of throwing", async () => {
		const src = path.join(tmp, "scripts-copy");
		fs.mkdirSync(src);
		for (const f of fs.readdirSync(__dirname).filter((n) => /^(runtime-preview.*|runtime-update|dev-stack-extensions)\.mjs$/.test(n))) fs.copyFileSync(path.join(__dirname, f), path.join(src, f));
		fs.rmSync(path.join(src, "runtime-preview-watch.mjs"));
		const mod = await import(`${path.join(src, "runtime-preview.mjs")}?partial`);
		const r = await mod.runPreview({ argv: ["status"], env: { HOME: home }, cwd: main, steps: {}, log: () => {}, warn: () => {} });
		expect(r.exitCode).toBe(0);
		expect(fs.existsSync(path.join(home, ".wolfpack", "preview", "bin", "runtime-preview-worktree.mjs"))).toBe(true);
	});

	it("every command refreshes the stable copy under ~/.wolfpack/preview/bin, so the bin never goes stale", async () => {
		const bin = path.join(home, ".wolfpack", "preview", "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "runtime-preview.mjs"), "// an old copy");
		await harness().run(["status"]);
		expect(fs.readFileSync(path.join(bin, "runtime-preview.mjs"), "utf8")).toContain("export async function runPreview");
		expect(fs.existsSync(path.join(bin, "runtime-preview-worktree.mjs"))).toBe(true);
		expect(fs.existsSync(path.join(bin, "runtime-preview-watch.mjs"))).toBe(true);
	});

	describe("watch script", () => {
		/** Run runtime-preview-watch.mjs against a fake tsc that prints `lines`; returns the watch file's content or undefined. */
		const watchWith = (lines: string[]) => {
			const wt = path.join(tmp, "wt-watch");
			fs.mkdirSync(path.join(wt, "node_modules", "typescript", "bin"), { recursive: true });
			fs.writeFileSync(path.join(wt, "node_modules", "typescript", "bin", "tsc"), `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n")}\n`);
			const wf = path.join(tmp, "watch.json");
			fs.rmSync(wf, { force: true });
			execFileSync(process.execPath, [path.join(__dirname, "runtime-preview-watch.mjs"), wt, wf, path.join(tmp, "watch.log")]);
			return fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, "utf8")) : undefined;
		};

		it("the first completed build is the baseline even with errors; every later error-free completion counts as a rebuild", () => {
			expect(watchWith(["Found 3 errors. Watching for file changes."])).toBeUndefined();
			expect(watchWith(["Found 0 errors. Watching for file changes."])).toBeUndefined();
			expect(watchWith(["Found 3 errors. Watching for file changes.", "Found 0 errors. Watching for file changes."])).toMatchObject({ lastRebuildOk: expect.any(String) });
			expect(watchWith(["Found 0 errors. Watching for file changes.", "Found 2 errors. Watching for file changes."])).toBeUndefined();
		});
	});
});
