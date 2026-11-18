import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { runPreview } from "./runtime-preview.mjs";
// @ts-expect-error plain .mjs script
import { createSlots } from "./runtime-preview-slots.mjs";
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
/** A checkout whose cli knows `preview` (what stable does not yet). */
const previewCapable = (d: string) => {
	fs.mkdirSync(path.join(d, "packages", "cli", "dist", "bin"), { recursive: true });
	fs.writeFileSync(path.join(d, "packages", "cli", "dist", "bin", "wolfpack.js"), "//");
	fs.mkdirSync(path.join(d, "packages", "cli", "dist", "commands"), { recursive: true });
	fs.writeFileSync(path.join(d, "packages", "cli", "dist", "commands", "preview.js"), "export const PREVIEW_CLI = 1;\n");
};
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
	fs.mkdirSync(path.join(ud(), "Wolfpack Console"), { recursive: true });
	fs.writeFileSync(path.join(ud(), "Wolfpack Console", "console.json"), JSON.stringify({ consoleUrl: "https://sfo-01.example" }));
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
const harness = (o: { confirm?: boolean | "none"; pick?: (items: Item[]) => unknown; realHealth?: boolean } = {}) => {
	const builds: { dir: string; logFile?: string }[] = [];
	const menus: Item[][] = [];
	const flags = { portBusy: false, consoleDown: false, probeStatus: 401 as number, unpaired: false, mintStatus: 200 as number, stray: null as null | { pid: number; command: string; cwd: string }, stubborn: false };
	const signals: string[] = [];
	const hubCalls: { url: string; method: string; auth?: string; body?: Record<string, unknown> }[] = [];
	const lc: string[][] = [];
	const helper: string[] = [];
	const asked: string[] = [];
	const logs: string[] = [];
	const opened: string[] = [];
	const installs: string[] = [];
	const steps: Record<string, unknown> = {
		launchctl: (...a: string[]) => (lc.push(a), 0),
		sleep: async () => {},
		cliLink: () => cliLink(),
		cliFallbackDir: () => fallbackDir(),
		portFree: async () => !flags.portBusy,
		listeners: async () => (flags.stray ? [flags.stray.pid] : []),
		procInfo: async (pid: number) => (flags.stray && flags.stray.pid === pid ? { command: flags.stray.command, cwd: flags.stray.cwd } : null),
		kill: (pid: number, sig: string) => {
			signals.push(`${sig} ${pid}`);
			if (sig === "SIGKILL" || (sig === "SIGTERM" && !flags.stubborn)) flags.stray = null;
		},
		probe: async () => (flags.consoleDown ? 0 : flags.probeStatus),
		hubFetch: async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
			hubCalls.push({ url, method: init.method, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
			if (url.endsWith("/v1/tokens/pairing-codes")) return flags.mintStatus === 200 ? { status: 200, json: { code: "ONE-TIME-CODE", expiresAt: "x" } } : { status: flags.mintStatus, json: { error: "forbidden" } };
			return { status: 200, json: { token: "BROWSER-SECRET", tokenId: "tok1" } };
		},
		fetchJson: async () => {
			if (flags.consoleDown) throw new Error("connection refused");
			if (flags.unpaired) throw new Error("answered 401"); // what the real step does for a non-2xx
			return { wolves: [{ id: "x", name: "1uk4" }], chats: [] };
		},
		build: (dir: string, b?: { logFile?: string }) => (builds.push({ dir, logFile: b?.logFile }), markBuilt(dir)),
		health: async () => true,
		open: (url: string) => void opened.push(url),
		install: (dir: string) => {
			installs.push(dir);
			fs.mkdirSync(path.join(dir, "apps", "console", "node_modules", "next", "dist", "bin"), { recursive: true });
			fs.writeFileSync(path.join(dir, "apps", "console", "node_modules", "next", "dist", "bin", "next"), "//");
		},
		pick: async (_title: string, items: Item[]) => (menus.push(items), o.pick ? o.pick(items) : null),
		spawnHelper: (a: { args: string[] }) => helper.push(a.args.slice(4).join(" ")),
	};
	if (o.realHealth) delete steps.health; // the production default, answered by a stubbed fetch
	if (o.confirm !== "none") steps.confirm = async (q: string) => (asked.push(q), o.confirm ?? true);
	const run = (argv: string[], cwd = main, extraEnv: Record<string, string> = {}) =>
		runPreview({ argv, env: { HOME: home, PREVIEW_USERDATA_ROOT: ud(), ...extraEnv }, cwd, steps, log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) });
	return { run, lc, helper, asked, logs, builds, menus, flags, opened, installs, hubCalls, signals };
};

const pairHub = () => {
	fs.mkdirSync(path.join(home, ".wolfpack", "workerd"), { recursive: true });
	fs.writeFileSync(path.join(home, ".wolfpack", "workerd", "hub.json"), JSON.stringify({ hubUrl: "http://100.64.0.9:3150", token: "WORKER-SECRET", hostId: "mac" }));
};

describe("console preview: pick a worktree, its live console opens in a browser tab, the wolves stay put", () => {
	const consolePlist = () => fs.readFileSync(path.join(home, "Library", "LaunchAgents", "com.wolfpack.preview-console.plist"), "utf8");
	const unchanged = (h: ReturnType<typeof harness>) => {
		expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(rt)); // the wolves' plist
		expect(h.helper).toEqual([]);
		expect(h.asked).toEqual([]); // no y/N
		expect(h.builds).toEqual([]);
		expect(h.lc.every((a) => a.join(" ").includes("preview-console"))).toBe(true); // only the console agent is touched
	};

	it("plain preview lists worktrees by branch and folder (no built/stale marks, no runtime checkout); picking one serves its next dev and opens the browser", async () => {
		fs.writeFileSync(path.join(wtB, "b.txt"), "b"); // an unmerged branch, so the picker lists it
		g(wtB, "add", "b.txt");
		g(wtB, "commit", "-q", "-m", "b");
		const h = harness({ pick: (items) => items.find((i) => i.label.startsWith("b "))?.value });
		expect((await h.run([], wtA)).exitCode).toBe(0);
		const labels = h.menus[0].map((i) => i.label);
		expect(labels).toContain("a  wt-a");
		expect(labels).toContain("b  wt-b");
		expect(labels.some((l) => /[●◐○]/.test(l) || l.startsWith("stable") || l.includes("rt"))).toBe(false);
		expect(consolePlist()).toContain(`<key>WorkingDirectory</key><string>${path.join(wtB, "apps", "console")}</string>`);
		expect(h.opened).toEqual(["http://127.0.0.1:3230"]);
		expect(readState()).toMatchObject({ console: { mode: "dev", dir: wtB }, consolePort: 3230 });
		expect(readState().previewRef).toBeUndefined();
		unchanged(h);
	});

	it("a worktree without node_modules gets one frozen install first, then the console and the browser", async () => {
		const wtC = path.join(tmp, "wt-c");
		g(main, "worktree", "add", "-q", "-b", "feat/c", wtC);
		const h = harness();
		expect((await h.run(["wt-c"])).exitCode).toBe(0);
		expect(h.installs).toEqual([wtC]);
		expect(h.logs.join("\n")).toContain("installing dependencies");
		expect(h.opened).toEqual(["http://127.0.0.1:3230"]);
		unchanged(h);
	});

	it("a name picks directly by a unique match on the folder or the branch; a path works too; nothing installs when node_modules exist", async () => {
		const byFolder = harness();
		await byFolder.run(["wt-a"]);
		expect(readState().console.dir).toBe(wtA);
		const byBranch = harness();
		await byBranch.run(["feat/b"]);
		expect(readState().console.dir).toBe(wtB);
		const byPath = harness();
		await byPath.run([wtA]);
		expect(readState().console.dir).toBe(wtA);
		expect([byFolder, byBranch, byPath].flatMap((x) => x.installs)).toEqual([]);
	});

	it("an ambiguous name lists the matches and a missing one says so; neither starts anything", async () => {
		const amb = harness();
		expect((await amb.run(["wt"])).exitCode).toBe(1);
		expect(amb.logs.join("\n")).toMatch(/matches more than one.*wt-a.*wt-b|wt-a[\s\S]*wt-b/);
		const none = harness();
		expect((await none.run(["nonesuch"])).exitCode).toBe(1);
		expect(none.logs.join("\n")).toContain('no worktree or ref matches "nonesuch"');
		for (const x of [amb, none]) {
			expect(x.lc).toEqual([]);
			expect(x.opened).toEqual([]);
		}
		expect(fs.existsSync(stateFile())).toBe(false);
	});

	it("picking another worktree while one runs switches the console in place and opens the URL again", async () => {
		const h = harness();
		await h.run(["wt-a"]);
		await h.run(["wt-b"]);
		expect(consolePlist()).toContain(path.join(wtB, "apps", "console"));
		expect(readState().console.dir).toBe(wtB);
		expect(h.opened).toEqual(["http://127.0.0.1:3230", "http://127.0.0.1:3230"]);
		unchanged(h);
	});

	it("--wolves [name] is the only way to move the wolves", async () => {
		const h = harness();
		expect((await h.run(["--wolves", "wt-a"])).exitCode).toBe(0);
		expect(readState()).toMatchObject({ mode: "worktree", worktree: wtA });
		expect(h.opened).toEqual([]);
		expect(h.asked.length).toBe(1);
	});
});

describe("status is one short block", () => {
	it("names the worktree, the URL and whether the console is up, and says the wolves are on stable", async () => {
		const h = harness();
		await h.run(["wt-a"]);
		h.logs.length = 0;
		await h.run(["status"]);
		expect(h.logs).toEqual([`worktree: a (${wtA})`, "console: http://127.0.0.1:3230 (up)", "hub: none (local wolves only)", "wolves: on stable"]);
	});

	it("says when the console is down and when the wolves were moved", async () => {
		const h = harness();
		await h.run(["--wolves", "wt-a"]);
		h.flags.consoleDown = true;
		h.logs.length = 0;
		await h.run(["status"]);
		expect(h.logs).toEqual([`worktree: a (${wtA})`, "console: http://127.0.0.1:3230 (down)", "hub: none (local wolves only)", `wolves: moved to feat/a (${wtA}); \`wolfpack preview off --all\` puts them back on stable`]);
	});
});

describe("worktree preview: the wolves run straight from a built worktree", () => {
	it("rewrites the stack plist to the worktree, serves the live console from it and hands over to the helper after one confirm", async () => {
		const h = harness();
		const r = await h.run(["--wolves", wtA]);
		expect(r.exitCode).toBe(0);
		expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(wtA));
		expect(h.asked.length).toBe(1);
		expect(h.helper).toEqual(["running 0"]);
		expect(readState()).toMatchObject({ mode: "worktree", worktree: wtA, previewRef: "feat/a", console: { mode: "dev", dir: wtA }, phase: "switching" });
		expect(h.lc.some((a) => a[0] === "bootstrap" && a[2].endsWith("com.wolfpack.preview-console.plist"))).toBe(true);
		// keys survive a switch: the console reads one key file under ~/.wolfpack/preview, not the served worktree's
		expect(fs.readFileSync(path.join(home, "Library", "LaunchAgents", "com.wolfpack.preview-console.plist"), "utf8")).toContain(
			`<key>WOLFPACK_KEY_FILE</key><string>${path.join(home, ".wolfpack", "preview", "keys.env")}</string>`,
		);
		expect(g(rt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("stable"); // the runtime checkout is not touched
	});

	it("a refused confirm, or no terminal without --yes, changes nothing; --yes skips the question", async () => {
		const before = stackPlist(rt);
		const no = harness({ confirm: false });
		expect((await no.run(["--wolves", wtA])).exitCode).toBe(1);
		const tty = harness({ confirm: "none" });
		expect((await tty.run(["--wolves", wtA])).exitCode).toBe(1);
		for (const h of [no, tty]) expect(h.helper).toEqual([]);
		expect(fs.readFileSync(plistFile(), "utf8")).toBe(before);
		expect(fs.existsSync(stateFile())).toBe(false);
		const yes = harness({ confirm: "none" });
		expect((await yes.run(["--wolves", wtA, "--yes"])).exitCode).toBe(0);
		expect(yes.helper).toEqual(["running 0"]);
	});

	it("switching to another worktree keeps the first plist as the original, and off restores its bytes exactly", async () => {
		const original = fs.readFileSync(plistFile());
		const h = harness();
		await h.run(["--wolves", wtA]);
		await h.run(["--wolves", wtB]);
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
		await h.run(["--wolves", wtA]);
		h.helper.length = 0;
		expect((await h.run(["off", "--rollback"])).exitCode).toBe(0);
		expect(fs.readFileSync(plistFile()).equals(original)).toBe(true);
		expect(h.helper).toEqual([]);
		expect(readState().mode).toBe("worktree");
	});

	it("the global wolfpack cli follows the worktree: record, repoint, keep the original through a switch, restore on off and rollback", async () => {
		const runtimeCli = path.join(rt, "packages", "cli");
		previewCapable(rt); // a runtime that has preview: the original link is a valid place to go back to
		const h = harness();
		await h.run(["--wolves", wtA]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(wtA, "packages", "cli"));
		expect(readState().cli).toMatchObject({ link: cliLink(), target: runtimeCli });
		await h.run(["--wolves", wtB]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(wtB, "packages", "cli"));
		expect(readState().cli.target).toBe(runtimeCli);
		await h.run(["off", "--rollback"]);
		expect(fs.readlinkSync(cliLink())).toBe(runtimeCli);
		await h.run(["off", "--all"]);
		expect(fs.readlinkSync(cliLink())).toBe(runtimeCli);
		await h.run(["--wolves", wtA]);
		await h.run(["off", "--console"]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(wtA, "packages", "cli")); // console-only leaves it
		await h.run(["off", "--all"]);
		expect(fs.readlinkSync(cliLink())).toBe(runtimeCli);
	});

	it("says the wolf session will end only when the command runs inside a wolf session (WOLF_NAME set); from Terminal it just says restoring stable", async () => {
		const h = harness();
		await h.run(["--wolves", wtA]);
		expect(h.logs.join("\n")).not.toContain("wolf session");
		h.logs.length = 0;
		await h.run(["off", "--all"]);
		expect(h.logs).toContain("restoring stable…");
		expect(h.logs.join("\n")).not.toContain("wolf session");
		await h.run(["--wolves", wtA], main, { WOLF_NAME: "1uk4" });
		expect(h.logs.join("\n")).toContain("the wolf session running this command will end");
		h.logs.length = 0;
		await h.run(["off", "--all"], main, { WOLF_NAME: "1uk4" });
		expect(h.logs.join("\n")).toContain("restoring stable: the wolf session running this command will end");
	});

	it("off never leaves the global cli on a stable that has no preview command: it moves to the picker checkout (or stays on the worktree's cli) and says so", async () => {
		const h = harness();
		markBuilt(fallbackDir());
		await h.run(["--wolves", wtA]);
		await h.run(["off", "--all"]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(fallbackDir(), "packages", "cli"));
		expect(h.logs.join("\n")).toContain(`wolfpack stays on ${fallbackDir()} so preview is available (stable has no preview yet)`);
		// no capable picker checkout: the link stays where the preview put it
		fs.rmSync(path.join(fallbackDir(), "packages", "cli", "dist"), { recursive: true });
		await h.run(["--wolves", wtA]);
		h.logs.length = 0;
		await h.run(["off", "--all"]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(wtA, "packages", "cli"));
		expect(h.logs.join("\n")).toContain(`wolfpack stays on ${wtA} so preview is available (stable has no preview yet)`);
	});

	it("a worktree whose cli predates the bin copy is not linked: the picker checkout's cli is, with a line saying so; restore is exact", async () => {
		const runtimeCli = path.join(rt, "packages", "cli");
		previewCapable(rt);
		oldCli(wtA);
		markBuilt(fallbackDir());
		const h = harness();
		await h.run(["--wolves", wtA]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(fallbackDir(), "packages", "cli"));
		expect(h.logs.join("\n")).toContain(`wolfpack CLI from ${fallbackDir()} (the previewed worktree's CLI predates preview)`);
		await h.run(["--wolves", wtB]); // compatible: used directly
		expect(fs.readlinkSync(cliLink())).toBe(path.join(wtB, "packages", "cli"));
		oldCli(wtB);
		await h.run(["--wolves", wtA]);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(fallbackDir(), "packages", "cli"));
		await h.run(["off", "--all"]);
		expect(fs.readlinkSync(cliLink())).toBe(runtimeCli);
	});

	it("when neither the worktree's cli nor the picker checkout's is compatible the link is left alone and the node bin fallback is printed", async () => {
		oldCli(wtA);
		fs.mkdirSync(path.join(fallbackDir(), "packages", "cli"), { recursive: true });
		const h = harness();
		expect((await h.run(["--wolves", wtA])).exitCode).toBe(0);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(rt, "packages", "cli"));
		expect(readState().cli).toBeUndefined();
		expect(h.logs.join("\n")).toContain("node ~/.wolfpack/preview/bin/runtime-preview.mjs");
	});

	it("a failed start leaves the cli link on its original target", async () => {
		const h = harness();
		await h.run(["dev", wtB]);
		h.flags.portBusy = true;
		expect((await h.run(["--wolves", wtA])).exitCode).toBe(1);
		expect(fs.readlinkSync(cliLink())).toBe(path.join(rt, "packages", "cli"));
	});

	it("a global cli that is a real install, not a link, is left untouched with a warning naming the bin fallback", async () => {
		fs.rmSync(cliLink());
		fs.mkdirSync(cliLink());
		fs.writeFileSync(path.join(cliLink(), "marker"), "x");
		const h = harness();
		expect((await h.run(["--wolves", wtA])).exitCode).toBe(0);
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
		await h.run(["--wolves", wtA]);
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
		expect((await h.run(["--wolves", wtA])).exitCode).toBe(1);
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
		expect((await h.run(["--wolves", wtA])).exitCode).toBe(1);
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
			await h.run(["--wolves", wtB, "--build"]);
			await h.run(["off", "--all"]);
			commit(wtB, "b.txt");
			commit(wtA, "a.txt");
			await h.run(["--wolves", wtA, "--build"]);
			fs.writeFileSync(path.join(wtA, "a.txt"), "edited");
			await h.run(["off", "--all"]);
			return h;
		};

		it("shows one short line per worktree (name, status mark, no paths), hides stable and the main checkout, and offers Show all at the bottom", async () => {
			const h = await setup();
			h.menus.length = 0;
			await h.run(["--wolves"], wtB);
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
			await h2.run(["--wolves"], wtB);
			expect(h2.menus.length).toBe(2);
			expect(h2.menus[1].map((i) => i.label).some((x) => x.startsWith("stable"))).toBe(false); // the runtime checkout is never offered
			expect(h2.menus[1].map((i) => i.label).some((x) => x.startsWith("main"))).toBe(true);
		});

		it("without a terminal prints the list and exits 1", async () => {
			const h = await setup();
			h.logs.length = 0;
			expect((await h.run(["--wolves"])).exitCode).toBe(1);
			expect(h.logs.join("\n")).toContain("◐ stale");
		});

		it("picking a not-built row builds it first, with output in last-run.log, then starts its preview", async () => {
			const h = await setup();
			const h2 = harness({ pick: (items) => items.find((i) => i.label.startsWith("yu741qH"))?.value });
			expect((await h2.run(["--wolves"], wtB)).exitCode).toBe(0);
			expect(h2.builds.map((b) => b.dir)).toEqual([path.join(tmp, "wt-c")]);
			expect(h2.builds[0].logFile).toBe(path.join(home, ".wolfpack", "preview", "last-run.log"));
			expect(h2.helper).toEqual(["running 0"]);
			void h;
		});

		it("picking a built row starts it without building", async () => {
			await setup();
			fs.writeFileSync(path.join(wtA, "a.txt"), "a.txt"); // undo the edit: built again
			const h2 = harness({ pick: (items) => items.find((i) => i.label.includes("● built"))?.value });
			expect((await h2.run(["--wolves"], wtB)).exitCode).toBe(0);
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

		it("hides stable, the main checkout, detached heads and clean merged branches, unless active or the cwd's; showAll lists all but stable", () => {
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
			expect(model(all, { showAll: true }).rows.length).toBe(7); // everything but the runtime branch
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

	describe("picker never offers the runtime checkout", () => {
		it("hides the runtime dir even under Show all and even when it is the cwd", () => {
			const worktrees = [
				{ dir: "/rt/wolfpack", branch: "feat/detached-at-stable", status: "built", dirty: false, merged: false, main: false, commitTime: 9 },
				{ dir: "/wt/a", branch: "feat/a", status: "built", dirty: false, merged: false, main: false, commitTime: 1 },
			];
			for (const showAll of [false, true]) {
				const { rows } = pickerModel({ worktrees, runtimeBranch: "stable", runtimeDir: "/rt/wolfpack", here: "/rt/wolfpack", showAll });
				expect(rows.map((r: { dir: string }) => r.dir)).toEqual(["/wt/a"]);
			}
		});
	});

	describe("build status without a stamp", () => {
		it("a worktree whose workerd and cli dist are newer than its HEAD commit counts as built; older dist counts as not built", async () => {
			const h = harness({ pick: () => null });
			h.menus.length = 0;
			await h.run(["--wolves"], wtA); // markBuilt just wrote dist files after the commit
			expect(h.logs.join("\n")).toContain("a  ● built");
			const old = new Date(Date.now() - 86_400_000 * 365);
			for (const f of [path.join(wtA, "packages", "workerd", "dist", "bin", "workerd.js"), path.join(wtA, "packages", "cli", "dist", "bin", "wolfpack.js")]) fs.utimesSync(f, old, old);
			h.logs.length = 0;
			await h.run(["--wolves"], wtA);
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
			await h.run(["--wolves", wtA]);
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
			await h.run(["--wolves", wtA]);
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
			await harness().run(["--wolves", wtA]);
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

		it("restart with the real health poll waits on /healthz, then clears restart needed", async () => {
			await harness().run(["--wolves", wtA]);
			fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), startedAt: new Date(Date.now() - 3_600_000).toISOString() }));
			fs.writeFileSync(watchJson(), JSON.stringify({ lastRebuildOk: new Date(Date.now() - 1_800_000).toISOString() }));
			const urls: string[] = [];
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (u: string) => (urls.push(String(u)), { ok: true })) as unknown as typeof fetch;
			try {
				const h = harness({ realHealth: true });
				expect((await h.run(["restart"])).exitCode).toBe(0);
			} finally {
				globalThis.fetch = realFetch;
			}
			expect(urls).toEqual(["http://127.0.0.1:7141/healthz"]);
			expect((await status(harness())).restartNeeded).toBe(false);
		});

		it("off --rollback (used by the helper) stops the watcher too", async () => {
			const h = harness();
			await h.run(["--wolves", wtA]);
			h.lc.length = 0;
			expect((await h.run(["off", "--rollback"])).exitCode).toBe(0);
			expect(h.lc.some((a) => a[0] === "bootout" && a[1].endsWith("com.wolfpack.preview-watch"))).toBe(true);
			expect(fs.existsSync(watchPlist())).toBe(false);
		});

		it("a worktree without typescript or a root tsconfig with references warns and starts no watcher, the preview still starts", async () => {
			fs.rmSync(path.join(wtA, "node_modules", "typescript"), { recursive: true });
			const h = harness();
			expect((await h.run(["--wolves", wtA])).exitCode).toBe(0);
			expect(fs.existsSync(watchPlist())).toBe(false);
			expect(h.logs.join("\n")).toMatch(/background rebuild did not start/);
			fs.writeFileSync(path.join(wtB, "tsconfig.json"), JSON.stringify({ files: [] }));
			const h2 = harness();
			await h2.run(["off", "--all"]);
			h2.logs.length = 0;
			await h2.run(["--wolves", wtB]);
			expect(fs.existsSync(watchPlist())).toBe(false);
			expect(h2.logs.join("\n")).toMatch(/background rebuild did not start/);
		});

		it("the watch and console agents are throttled so a crash loop cannot spin", async () => {
			await harness().run(["--wolves", wtA]);
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
	describe("off stops the console, then asks about the wolves only if they were moved", () => {
		const appUrl = () => JSON.parse(fs.readFileSync(path.join(ud(), "Wolfpack Console", "console.json"), "utf8")).consoleUrl;
		const consoleStopped = (h: ReturnType<typeof harness>) => h.lc.some((a) => a[0] === "bootout" && a[1].endsWith("com.wolfpack.preview-console"));

		it("with only the console running it stops it without a question and clears the state; the wolves are never touched", async () => {
			const h = harness();
			await h.run(["wt-a"]);
			h.lc.length = 0;
			expect((await h.run(["off"])).exitCode).toBe(0);
			expect(h.asked).toEqual([]);
			expect(consoleStopped(h)).toBe(true);
			expect(fs.existsSync(stateFile())).toBe(false);
			expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(rt));
			expect(h.helper).toEqual([]);
		});

		it("with the wolves moved it stops the console, asks one y/N, and yes restores the plist and hands over to the helper", async () => {
			const h = harness();
			await h.run(["--wolves", wtA]);
			h.helper.length = 0;
			h.asked.length = 0;
			h.lc.length = 0;
			expect((await h.run(["off"])).exitCode).toBe(0);
			expect(h.asked.length).toBe(1);
			expect(h.asked[0]).toContain("stable");
			expect(consoleStopped(h)).toBe(true);
			expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(rt));
			expect(h.helper).toEqual(["stable 1"]);
		});

		it("answering no stops the console but leaves the wolves on the worktree", async () => {
			await harness().run(["--wolves", wtA]);
			const h = harness({ confirm: false });
			expect((await h.run(["off"])).exitCode).toBe(0);
			expect(consoleStopped(h)).toBe(true);
			expect(h.helper).toEqual([]);
			expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(wtA));
			expect(readState()).toMatchObject({ mode: "worktree", worktree: wtA });
			expect(readState().console).toBeUndefined();
		});

		it("without a terminal it stops the console, leaves the wolves, and says how to put them back", async () => {
			await harness().run(["--wolves", wtA]);
			const h = harness({ confirm: "none" });
			expect((await h.run(["off"])).exitCode).toBe(0);
			expect(consoleStopped(h)).toBe(true);
			expect(h.helper).toEqual([]);
			expect(h.logs.join("\n")).toContain("wolfpack preview off --all");
			expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(wtA));
		});

		it("--all restores the wolves without asking", async () => {
			const h = harness();
			await h.run(["--wolves", wtA]);
			h.asked.length = 0;
			h.helper.length = 0;
			expect((await h.run(["off", "--all", "--yes"])).exitCode).toBe(0);
			expect(h.asked).toEqual([]);
			expect(h.helper).toEqual(["stable 1"]);
		});

		it("--console stops the live console but leaves the wolves on the worktree, and the app stays on its own console", async () => {
			const h = harness();
			await h.run(["--wolves", wtA]);
			expect(appUrl()).toBe("https://sfo-01.example"); // starting never points the app
			h.helper.length = 0;
			h.asked.length = 0;
			h.lc.length = 0;
			expect((await h.run(["off", "--console"])).exitCode).toBe(0);
			expect(h.asked).toEqual([]); // the flag skips the question
			expect(appUrl()).toBe("https://sfo-01.example");
			expect(h.lc.some((a) => a[0] === "bootout" && a[1].endsWith("com.wolfpack.preview-console"))).toBe(true);
			expect(h.helper).toEqual([]);
			expect(fs.readFileSync(plistFile(), "utf8")).toBe(stackPlist(wtA));
			expect(readState()).toMatchObject({ mode: "worktree", worktree: wtA });
			expect(readState().console).toBeUndefined();
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
		const r = await mod.runPreview({ argv: ["status"], env: { HOME: home }, cwd: main, steps: { listeners: async () => [], procInfo: async () => null }, log: () => {}, warn: () => {} }); // no real lsof: status looks for a stray next dev on 3230
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

describe("worktrees are found from any directory", () => {
	it("a name and the picker work from a directory outside any repo, via the runtime checkout", async () => {
		const wl = path.join(tmp, "wl");
		fs.mkdirSync(path.join(wl, "runtime"), { recursive: true });
		g(main, "worktree", "move", rt, path.join(wl, "runtime", "wolfpack"));
		const away = path.join(tmp, "elsewhere"); // not a git repo
		fs.mkdirSync(away);
		const h = harness();
		const r = await h.run(["feat/a"], away, { WOLVES_DIR: wl });
		expect(r.exitCode).toBe(0);
		expect(readState().console.dir).toBe(fs.realpathSync(wtA));
		const p = harness({ pick: (items) => items.find((i) => String(i.label).includes("wt-a"))?.value });
		expect((await p.run([], away, { WOLVES_DIR: wl })).exitCode).toBe(0);
		expect(p.menus[0].some((i) => String(i.label).includes("wt-a"))).toBe(true);
	});
});

describe("worktrees from inside an unrelated git repo", () => {
	it("a cwd in another repo (the home dir is one) does not hide the wolfpack worktrees", async () => {
		const wl = path.join(tmp, "wl");
		fs.mkdirSync(path.join(wl, "runtime"), { recursive: true });
		g(main, "worktree", "move", rt, path.join(wl, "runtime", "wolfpack"));
		const homeRepo = path.join(tmp, "homerepo");
		fs.mkdirSync(homeRepo);
		g(homeRepo, "init", "-q", "-b", "master"); // empty, no commits
		const h = harness();
		const r = await h.run(["feat/a"], homeRepo, { WOLVES_DIR: wl });
		expect(r.exitCode).toBe(0);
		expect(readState().console.dir).toBe(fs.realpathSync(wtA));
	});

	it("a cwd inside a wolfpack worktree still lists that repo's worktrees", async () => {
		const h = harness();
		expect((await h.run(["feat/b"], wtA)).exitCode).toBe(0);
		expect(readState().console.dir).toBe(fs.realpathSync(wtB));
	});
});

describe("a stray next dev on the preview port", () => {
	const strayOf = (cwd: string) => ({ pid: 4242, command: "next-server (v15.0.0)", cwd });
	const consoleDir = () => path.join(wtA, "apps", "console");

	it("off frees the port from a next dev that no launchd agent owns: SIGTERM, one line naming it", async () => {
		const h = harness();
		await h.run(["dev", wtA]);
		h.flags.stray = strayOf(consoleDir());
		expect((await h.run(["off"])).exitCode).toBe(0);
		expect(h.signals).toEqual(["SIGTERM 4242"]);
		expect(h.logs.join("\n")).toContain("stopped next dev (pid 4242) on port 3230");
	});

	it("off with no state at all still frees the port", async () => {
		const h = harness();
		h.flags.stray = strayOf(consoleDir());
		await h.run(["off"]);
		expect(h.signals).toEqual(["SIGTERM 4242"]);
	});

	it("a listener that ignores SIGTERM is killed with SIGKILL after 5 s", async () => {
		const h = harness();
		h.flags.stray = strayOf(consoleDir());
		h.flags.stubborn = true;
		await h.run(["off"]);
		expect(h.signals).toEqual(["SIGTERM 4242", "SIGKILL 4242"]);
	});

	it("never kills anything else: not a next process, or a next whose cwd is not a checkout's apps/console", async () => {
		const h = harness();
		h.flags.stray = { pid: 77, command: "node server.js", cwd: consoleDir() };
		await h.run(["off"]);
		h.flags.stray = { pid: 78, command: "next-server (v15.0.0)", cwd: os.tmpdir() };
		await h.run(["off"]);
		expect(h.signals).toEqual([]);
	});

	it("status says a stray console runs outside preview and how to stop it", async () => {
		const h = harness();
		h.flags.stray = strayOf(consoleDir()); // no state: nothing recorded it
		await h.run(["status"]);
		expect(h.logs.join("\n")).toContain("console: http://127.0.0.1:3230 (running outside preview; `wolfpack preview off` stops it)");
	});
});

describe("automatic browser sign-in in hub mode", () => {
	const pairedMarker = () => path.join(home, ".wolfpack", "preview", "paired.json");
	const consoleToken = { WOLFPACK_HUB_TOKEN: "CONSOLE-SECRET" };

	it("mints a browser code with the Mac's console token, redeems it, opens /pair#token, remembers only the token id, and never prints a secret", async () => {
		pairHub();
		const h = harness();
		h.flags.unpaired = true;
		expect((await h.run(["dev", wtA], main, consoleToken)).exitCode).toBe(0);
		const r = await h.run([wtA], main, consoleToken);
		expect(r.exitCode).toBe(0);
		expect(h.opened).toEqual(["http://127.0.0.1:3230/pair#token=BROWSER-SECRET"]);
		expect(h.hubCalls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST http://100.64.0.9:3150/v1/tokens/pairing-codes", "POST http://100.64.0.9:3150/v1/pair"]);
		expect(h.hubCalls[0].auth).toBe("Bearer CONSOLE-SECRET");
		expect(h.hubCalls[1].body).toMatchObject({ code: "ONE-TIME-CODE", kind: "browser" });
		expect(String(h.hubCalls[1].body?.label)).toMatch(/^preview /);
		const marker = fs.readFileSync(pairedMarker(), "utf8");
		expect(JSON.parse(marker)).toMatchObject({ tokenId: "tok1" });
		for (const secret of ["BROWSER-SECRET", "ONE-TIME-CODE", "CONSOLE-SECRET", "WORKER-SECRET"]) {
			expect(marker + h.logs.join("\n")).not.toContain(secret);
		}
	});

	it("a later run opens / only, and `preview pair` forces a fresh pairing", async () => {
		pairHub();
		const h = harness();
		await h.run([wtA], main, consoleToken);
		h.opened.length = 0;
		h.hubCalls.length = 0;
		await h.run([wtA], main, consoleToken);
		expect(h.opened).toEqual(["http://127.0.0.1:3230/"]);
		expect(h.hubCalls).toEqual([]);
		expect((await h.run(["pair"], main, consoleToken)).exitCode).toBe(0);
		expect(h.opened[1]).toBe("http://127.0.0.1:3230/pair#token=BROWSER-SECRET");
		expect(h.hubCalls.length).toBe(2);
	});

	it("when the Mac's token cannot mint (a worker token gets 403) it opens /pair and prints the hubd command; nothing is remembered", async () => {
		pairHub();
		const h = harness();
		h.flags.mintStatus = 403;
		expect((await h.run([wtA])).exitCode).toBe(0);
		expect(h.opened).toEqual(["http://127.0.0.1:3230/pair"]);
		expect(h.hubCalls[0].auth).toBe("Bearer WORKER-SECRET");
		expect(h.logs.join("\n")).toMatch(/hubd pair --kind browser/);
		expect(fs.existsSync(pairedMarker())).toBe(false);
		expect(h.logs.join("\n")).not.toContain("WORKER-SECRET");
	});
});

describe("hub mode health", () => {
	const ready = (h: ReturnType<typeof harness>) => h.run(["dev", wtA]);

	it("in hub mode a console that compiles and answers /api/wolves 401 (not paired yet) is up and stays running", async () => {
		pairHub();
		const h = harness();
		h.flags.unpaired = true;
		const r = await ready(h);
		expect(r.exitCode).toBe(0);
		expect(readState().console).toMatchObject({ mode: "dev" });
		expect(h.lc.filter((a) => a[0] === "bootout").length).toBe(2); // the start-up cleanups only, no teardown
	});

	it("in hub mode a 500 or a refusal is not up: the console is stopped and the run fails", async () => {
		pairHub();
		const h = harness();
		h.flags.unpaired = true;
		h.flags.probeStatus = 500;
		expect((await ready(h)).exitCode).toBe(1);
		expect(h.lc.filter((a) => a[0] === "bootout").length).toBe(3); // start-up cleanups plus the teardown
	});
});

describe("default steps", () => {
	it("every step the command calls has a real default, so a test that injects it cannot hide a missing one", () => {
		const src = fs.readFileSync(path.join(__dirname, "runtime-preview.mjs"), "utf8");
		const used = new Set([...src.matchAll(/\bst\.(\w+)\(/g)].map((m) => m[1]));
		const block = src.slice(src.indexOf("const defaultSteps = {"), src.indexOf("export async function runPreview"));
		const defined = new Set([...block.matchAll(/^\t(\w+)(?::|,| \()/gm)].map((m) => m[1]));
		expect([...used].filter((u) => !defined.has(u))).toEqual([]);
	});
});

describe("agent slots through `wolfpack preview slot`", () => {
	const slotsFile = () => path.join(home, ".wolfpack", "preview", "slots.json");
	const fakeSlots = (o: object) => createSlots({ ...o, spawn: () => 4242, isAlive: (pid: number) => pid === 4242, kill: () => {}, reapLeftovers: () => {}, prepare: () => {}, portFree: async () => true, servedElsewhere: () => null, waitListening: async () => true });
	const slot = async (...argv: string[]) => {
		const out: string[] = [];
		const err: string[] = [];
		const r = await runPreview({ argv: ["slot", ...argv], env: { HOME: home, WOLFPACK_HUB_TOKEN: "t" }, cwd: main, steps: { slots: fakeSlots }, log: (m: string) => out.push(m), warn: (m: string) => err.push(m) });
		return { code: r.exitCode, out, err };
	};

	it("get --json names the worktree's slot by port and url", async () => {
		const r = await slot("get", "wt-a", "--json");
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out[0])).toMatchObject({ port: 3231, url: "http://127.0.0.1:3231", worktree: wtA });
	});

	it("release takes the worktree's name, even after the worktree is deleted, with no error output", async () => {
		await slot("get", "wt-a");
		fs.rmSync(wtA, { recursive: true, force: true });
		const r = await slot("release", "wt-a");
		expect(r).toEqual({ code: 0, out: ["released slot 3231"], err: [] });
	});

	it("status lists running slots and writes nothing", async () => {
		const before = await runPreview({ argv: ["status"], env: { HOME: home }, cwd: main, steps: { slots: fakeSlots, listeners: async () => [], procInfo: async () => null }, log: () => {}, warn: () => {} });
		expect(before.exitCode).toBe(0);
		expect(fs.existsSync(slotsFile())).toBe(false);
		expect(fs.existsSync(`${slotsFile().replace("slots.json", "slots.lock")}`)).toBe(false);
		fs.mkdirSync(path.dirname(slotsFile()), { recursive: true });
		const seeded = JSON.stringify({ slots: [{ port: 3231, worktree: wtA, pid: 4242, startedAt: 1, lastUsed: 1 }, { port: 3232, worktree: wtB, pid: 4343, startedAt: 1, lastUsed: 1 }] });
		fs.writeFileSync(slotsFile(), seeded);
		const logs: string[] = [];
		await runPreview({ argv: ["status"], env: { HOME: home }, cwd: main, steps: { slots: fakeSlots, listeners: async () => [], procInfo: async () => null }, log: (m: string) => logs.push(m), warn: () => {} });
		expect(logs).toContain("slots: 3231 wt-a");
		expect(fs.readFileSync(slotsFile(), "utf8")).toBe(seeded);
	});

	describe("slot pair", () => {
		const tokenFile = () => path.join(home, ".wolfpack", "preview", "hub-token");
		const pair = async (argv: string[], o: { mintStatus?: number; redeemStatus?: number; openStatus?: number; env?: Record<string, string>; fileToken?: string | null } = {}) => {
			fs.mkdirSync(path.join(home, ".wolfpack", "workerd"), { recursive: true });
			fs.writeFileSync(path.join(home, ".wolfpack", "workerd", "hub.json"), JSON.stringify({ hubUrl: "http://100.64.0.9:3150", token: "WORKER-SECRET" }));
			if (o.fileToken !== null) {
				fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
				fs.writeFileSync(tokenFile(), o.fileToken ?? "FILE-TOKEN-0123456789", { mode: 0o600 });
			}
			const out: string[] = [];
			const err: string[] = [];
			const opened: string[] = [];
			const calls: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
			const r = await runPreview({
				argv: ["slot", "pair", ...argv],
				env: { HOME: home, ...(o.env ?? {}) },
				cwd: main,
				steps: {
					slots: fakeSlots,
					open: (u: string) => (opened.push(u), o.openStatus ?? 0),
					hubFetch: async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
						calls.push({ url, auth: init.headers?.Authorization, body: JSON.parse(init.body ?? "{}") });
						if (url.endsWith("/v1/tokens/pairing-codes")) return { status: o.mintStatus ?? 200, json: o.mintStatus && o.mintStatus !== 200 ? {} : { code: "BROWSER-CODE" } };
						if (o.redeemStatus && o.redeemStatus !== 200) return { status: o.redeemStatus, json: {} };
						return { status: 200, json: { token: "SLOT-BROWSER-TOKEN", tokenId: "tok_b7", kind: "browser" } };
					},
				},
				log: (m: string) => out.push(m),
				warn: (m: string) => err.push(m),
			});
			return { code: r.exitCode, out, err, opened, calls };
		};

		/** Both tokens present; the hub refuses the first and accepts the second, so the order is observable. */
		const runPairWith = async (authSeen: string[]) => {
			fs.mkdirSync(path.join(home, ".wolfpack", "workerd"), { recursive: true });
			fs.writeFileSync(path.join(home, ".wolfpack", "workerd", "hub.json"), JSON.stringify({ hubUrl: "http://100.64.0.9:3150", token: "WORKER-SECRET" }));
			fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
			fs.writeFileSync(tokenFile(), "FILE-TOKEN-0123456789", { mode: 0o600 });
			const r = await runPreview({
				argv: ["slot", "pair", "3231"],
				env: { HOME: home, WOLFPACK_HUB_TOKEN: "ENV-TOKEN-0123456789" },
				cwd: main,
				steps: {
					slots: fakeSlots,
					open: () => 0,
					hubFetch: async (url: string, init: { headers?: Record<string, string> }) => {
						if (url.endsWith("/v1/tokens/pairing-codes")) {
							authSeen.push(init.headers?.Authorization ?? "");
							return authSeen.length === 1 ? { status: 403, json: {} } : { status: 200, json: { code: "C" } };
						}
						return { status: 200, json: { token: "T", tokenId: "tok_x" } };
					},
				},
				log: () => {},
				warn: () => {},
			});
			return { code: r.exitCode };
		};

		it("mints a browser code with the hub-token file, redeems it as a browser token, opens /pair#token= on the slot port, and prints only the id", async () => {
			await slot("get", "wt-a"); // slot 3231
			const r = await pair(["3231"]);
			expect(r.code).toBe(0);
			expect(r.calls).toEqual([
				{ url: "http://100.64.0.9:3150/v1/tokens/pairing-codes", auth: "Bearer FILE-TOKEN-0123456789", body: { label: `preview slot 3231 ${os.hostname()}` } },
				{ url: "http://100.64.0.9:3150/v1/pair", auth: undefined, body: { code: "BROWSER-CODE", label: `preview slot 3231 ${os.hostname()}` } }, // no kind, as `token` does: the code itself is a browser code
			]);
			expect(r.opened).toEqual(["http://127.0.0.1:3231/pair#token=SLOT-BROWSER-TOKEN"]);
			expect(r.out).toEqual(["signed in your browser on :3231 (token id tok_b7)"]);
			expect([...r.out, ...r.err].join("\n")).not.toContain("SLOT-BROWSER-TOKEN");
			expect(fs.readFileSync(slotsFile(), "utf8")).not.toContain("SLOT-BROWSER-TOKEN");
		});

		it("a second pair revokes the first token id before minting, so one live token per port; a failed revoke warns and still pairs; release revokes the last one", async () => {
			await slot("get", "wt-a");
			fs.mkdirSync(path.join(home, ".wolfpack", "workerd"), { recursive: true });
			fs.writeFileSync(path.join(home, ".wolfpack", "workerd", "hub.json"), JSON.stringify({ hubUrl: "http://100.64.0.9:3150" }));
			fs.writeFileSync(tokenFile(), "FILE-TOKEN-0123456789", { mode: 0o600 });
			const events: string[] = [];
			const warnings: string[] = [];
			let revokeStatus = 200;
			let n = 0;
			const hub = async (url: string, init: { method?: string }) => {
				if (init.method === "DELETE") {
					events.push(`revoke ${url.split("/").pop()}`);
					return { status: revokeStatus, json: {} };
				}
				if (url.endsWith("/v1/tokens/pairing-codes")) return { status: 200, json: { code: "C" } };
				events.push("mint");
				return { status: 200, json: { token: "SLOT-BROWSER-TOKEN", tokenId: `tok_${++n}` } };
			};
			const slots = (o: object) => fakeSlots({ ...o, hubFetch: hub, warn: (m: string) => warnings.push(m) });
			const run = (argv: string[]) => runPreview({ argv, env: { HOME: home }, cwd: main, steps: { slots, open: () => 0, hubFetch: hub }, log: () => {}, warn: (m: string) => warnings.push(m) });
			expect((await run(["slot", "pair", "3231"])).exitCode).toBe(0);
			expect((await run(["slot", "pair", "3231"])).exitCode).toBe(0);
			expect(events).toEqual(["mint", "revoke tok_1", "mint"]);
			revokeStatus = 0; // hub down for the revoke: pairing still works
			expect((await run(["slot", "pair", "3231"])).exitCode).toBe(0);
			expect(events.slice(3)).toEqual(["revoke tok_2", "mint"]);
			expect(warnings.join("\n")).toContain("tok_2");
			expect(warnings.join("\n")).not.toContain("SLOT-BROWSER-TOKEN");
			revokeStatus = 200;
			expect((await run(["slot", "release", "3231"])).exitCode).toBe(0);
			expect(events.slice(5)).toEqual(["revoke tok_3"]);
		});

		it("an agent pair (--print-url) and an owner pair do not revoke each other's token; a token that cannot be recorded is revoked, not orphaned", async () => {
			await slot("get", "wt-a");
			fs.mkdirSync(path.join(home, ".wolfpack", "workerd"), { recursive: true });
			fs.writeFileSync(path.join(home, ".wolfpack", "workerd", "hub.json"), JSON.stringify({ hubUrl: "http://100.64.0.9:3150" }));
			fs.writeFileSync(tokenFile(), "FILE-TOKEN-0123456789", { mode: 0o600 });
			const revoked: string[] = [];
			let n = 0;
			const hub = async (url: string, init: { method?: string }) => {
				if (init.method === "DELETE") return (revoked.push(url.split("/").pop() ?? ""), { status: 200, json: {} });
				if (url.endsWith("/v1/tokens/pairing-codes")) return { status: 200, json: { code: "C" } };
				return { status: 200, json: { token: "SLOT-BROWSER-TOKEN", tokenId: `tok_${++n}` } };
			};
			let failRecord = false;
			const slots = (o: object) => {
				const s = fakeSlots({ ...o, hubFetch: hub, warn: () => {} });
				const record = s.recordToken;
				s.recordToken = async (...a: unknown[]) => (failRecord ? Promise.reject(new Error("disk full")) : record(...a));
				return s;
			};
			const run = (argv: string[]) => runPreview({ argv, env: { HOME: home }, cwd: main, steps: { slots, open: () => 0, hubFetch: hub }, log: () => {}, warn: () => {} });
			await run(["slot", "pair", "3231"]); // owner tok_1
			await run(["slot", "pair", "3231", "--print-url"]); // agent tok_2
			expect(revoked).toEqual([]);
			await run(["slot", "pair", "3231", "--print-url"]); // agent tok_3 replaces tok_2 only
			expect(revoked).toEqual(["tok_2"]);
			failRecord = true;
			expect((await run(["slot", "pair", "3231"])).exitCode).toBe(1); // owner tok_4 replaces tok_1, then cannot be recorded
			expect(revoked).toEqual(["tok_2", "tok_1", "tok_4"]);
		});

		it("--print-url writes only the URL to stdout, opens nothing, and keeps messages on stderr", async () => {
			await slot("get", "wt-a");
			const r = await pair(["3231", "--print-url"]);
			expect(r.code).toBe(0);
			expect(r.out).toEqual(["http://127.0.0.1:3231/pair#token=SLOT-BROWSER-TOKEN"]);
			expect(r.opened).toEqual([]);
			expect(r.err.join("\n")).toContain("tok_b7");
			expect(r.err.join("\n")).not.toContain("SLOT-BROWSER-TOKEN");
		});

		it("uses WOLFPACK_HUB_TOKEN when there is no token file", async () => {
			await slot("get", "wt-a");
			const r = await pair(["3231"], { fileToken: null, env: { WOLFPACK_HUB_TOKEN: "ENV-TOKEN-0123456789" } });
			expect(r.code).toBe(0);
			expect(r.calls[0].auth).toBe("Bearer ENV-TOKEN-0123456789");
		});

		it("refuses a port that is not a running slot, without asking the hub", async () => {
			await slot("get", "wt-a");
			for (const port of ["3232", "x"]) {
				const r = await pair([port]);
				expect({ port, code: r.code, calls: r.calls, opened: r.opened, out: r.out }).toEqual({ port, code: 1, calls: [], opened: [], out: [] });
				expect(r.err.join("\n")).toMatch(/not a running slot/);
			}
		});

		it("refuses port 3230 even when a live slot record sits on it, and a record whose runner is dead", async () => {
			await slot("get", "wt-a"); // 3231, runner pid 4242 (alive in the fake)
			const rec = (port: number, pid: number) => ({ port, worktree: wtB, pid, startedAt: 1, lastUsed: Date.now() });
			const file = JSON.parse(fs.readFileSync(slotsFile(), "utf8"));
			file.slots.push(rec(3230, 4242), rec(3232, 9999)); // 3230 live (pid 4242); 3232 dead runner (pid 9999 is not alive)
			fs.writeFileSync(slotsFile(), JSON.stringify(file));
			for (const port of ["3230", "3232"]) {
				const r = await pair([port]);
				expect({ port, code: r.code, calls: r.calls, opened: r.opened }).toEqual({ port, code: 1, calls: [], opened: [] });
				expect(r.err.join("\n")).toMatch(/not a running slot/);
			}
		});

		it("tries the hub-token file first, then WOLFPACK_HUB_TOKEN when the file's token cannot mint", async () => {
			await slot("get", "wt-a");
			const calls: string[] = [];
			const r = await runPairWith(calls);
			expect(r.code).toBe(0);
			expect(calls).toEqual(["Bearer FILE-TOKEN-0123456789", "Bearer ENV-TOKEN-0123456789"]);
		});

		it("says the hub answered N when redeeming, not that no token can mint, when the mint worked but the redeem failed", async () => {
			await slot("get", "wt-a");
			const r = await pair(["3231", "--print-url"], { redeemStatus: 401 });
			expect({ code: r.code, out: r.out, opened: r.opened }).toEqual({ code: 1, out: [], opened: [] });
			expect(r.err.join("\n")).toMatch(/hub answered 401 when redeeming the pairing code/);
			expect(r.err.join("\n")).not.toMatch(/no token on this Mac/);
		});

		it("exits 1 when the browser cannot be opened, and the message does not contain the URL or the token", async () => {
			await slot("get", "wt-a");
			const r = await pair(["3231"], { openStatus: 1 });
			expect({ code: r.code, out: r.out }).toEqual({ code: 1, out: [] });
			expect(r.err.join("\n")).toMatch(/could not open the browser/);
			expect(r.err.join("\n")).not.toMatch(/SLOT-BROWSER-TOKEN|127\.0\.0\.1|\/pair#/);
		});

		it("with no token that can mint (none, or the hub answers 403) exits 1 and prints the setup lines, never opening or printing a URL", async () => {
			await slot("get", "wt-a");
			for (const o of [{ fileToken: null }, { mintStatus: 403 }]) {
				const r = await pair(["3231", "--print-url"], o);
				expect({ code: r.code, out: r.out, opened: r.opened }).toEqual({ code: 1, out: [], opened: [] });
				expect(r.err.join("\n")).toMatch(/Pack → Devices → add device/);
				expect(r.err.join("\n")).toContain("wolfpack preview token");
				expect(r.err.join("\n")).not.toContain("FILE-TOKEN-0123456789");
			}
		});
	});

	it("get warns, naming the token file, when there is no hub token; and warns about a file open to group or other, never printing the value", async () => {
		const tf = path.join(home, ".wolfpack", "preview", "hub-token");
		const get = async (wt: string) => {
			const out: string[] = [];
			const err: string[] = [];
			const r = await runPreview({ argv: ["slot", "get", wt, "--json"], env: { HOME: home }, cwd: main, steps: { slots: fakeSlots }, log: (m: string) => out.push(m), warn: (m: string) => err.push(m) });
			return { code: r.exitCode, text: [...out, ...err].join("\n"), err: err.join("\n"), out };
		};
		const none = await get("wt-a");
		// Key parts only, not the whole wording: the console route, the hubd pair command for a browser token, and the command to run here.
		for (const text of [none.err, JSON.parse(none.out[0]).tokenSetup.join("\n")]) {
			expect(text).toMatch(/Pack → Devices → add device/);
			expect(text).toMatch(/hubd pair --kind browser --label "preview [^"]+"/);
			expect(text).not.toContain("--kind console");
			expect(text).toContain("wolfpack preview token");
		}
		expect(none.err).toMatch(/no hub token/);
		expect(JSON.parse(none.out[0])).toMatchObject({ noToken: true });
		expect(JSON.parse(none.out[0]).tokenSetup).toHaveLength(2);
		fs.mkdirSync(path.dirname(tf), { recursive: true });
		fs.writeFileSync(tf, "SECRET-VALUE\n", { mode: 0o644 });
		fs.chmodSync(tf, 0o644);
		const loose = await get("wt-b");
		expect(loose.code).toBe(0);
		expect(loose.err).toMatch(/hub-token.*group or other.*chmod 600/);
		expect(loose.text).not.toContain("SECRET-VALUE");
	});

	it("get --json without a token is still pure JSON on stdout, and with one carries no tokenSetup", async () => {
		fs.mkdirSync(path.join(home, ".wolfpack", "preview"), { recursive: true });
		fs.writeFileSync(path.join(home, ".wolfpack", "preview", "hub-token"), "T\n", { mode: 0o600 });
		const out: string[] = [];
		await runPreview({ argv: ["slot", "get", "wt-a", "--json"], env: { HOME: home }, cwd: main, steps: { slots: fakeSlots }, log: (m: string) => out.push(m), warn: () => {} });
		expect(Object.keys(JSON.parse(out[0]))).not.toContain("tokenSetup");
	});
});

describe("wolfpack preview token", () => {
	const tokenFile = () => path.join(home, ".wolfpack", "preview", "hub-token");
	const withHub = () => {
		fs.mkdirSync(path.join(home, ".wolfpack", "workerd"), { recursive: true });
		fs.writeFileSync(path.join(home, ".wolfpack", "workerd", "hub.json"), JSON.stringify({ hubUrl: "http://100.64.0.9:3150", token: "WORKER-SECRET" }));
	};
	const redeem = async (o: { status?: number; json?: object; code?: string | null; argv?: string[] } = {}) => {
		const calls: { url: string; method?: string; body?: Record<string, unknown> }[] = [];
		const out: string[] = [];
		const err: string[] = [];
		const asked: boolean[] = [];
		const r = await runPreview({
			argv: ["token", ...(o.argv ?? [])],
			env: { HOME: home },
			cwd: main,
			steps: {
				readCode: async (opts: { fromStdin: boolean }) => (asked.push(opts.fromStdin), o.code === undefined ? "ONE-TIME-CODE" : o.code),
				hubFetch: async (url: string, init: { method?: string; body?: string }) => (calls.push({ url, method: init.method, body: JSON.parse(init.body ?? "{}") }), { status: o.status ?? 200, json: o.json ?? { token: "NEW-HUB-TOKEN", tokenId: "tok_42" } }),
			},
			log: (m: string) => out.push(m),
			warn: (m: string) => err.push(m),
		});
		return { code: r.exitCode, calls, out, err, asked };
	};

	it("redeems the code without naming a kind (so a browser or console code both work), saves the token owner-only, and prints the id but never the token", async () => {
		withHub();
		const r = await redeem({ argv: ["--code-stdin"] });
		expect(r.code).toBe(0);
		expect(r.calls).toEqual([{ url: "http://100.64.0.9:3150/v1/pair", method: "POST", body: { code: "ONE-TIME-CODE", label: `preview ${os.hostname()}` } }]);
		expect(r.asked).toEqual([true]);
		expect(fs.readFileSync(tokenFile(), "utf8")).toBe("NEW-HUB-TOKEN");
		expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
		expect(r.out).toEqual(["saved hub token for preview slots (id tok_42)"]);
		expect([...r.out, ...r.err].join("\n")).not.toContain("NEW-HUB-TOKEN");
		expect(fs.readdirSync(path.dirname(tokenFile())).filter((f) => f.startsWith("hub-token"))).toEqual(["hub-token"]); // no temp file left
	});

	it("refuses a worker token: saves nothing, and names the token to revoke", async () => {
		withHub();
		const r = await redeem({ json: { token: "WORKER-TOKEN-VALUE", tokenId: "tok_w1", kind: "worker" } });
		expect(r.code).toBe(1);
		expect(r.err.join("\n")).toMatch(/worker token.*tok_w1.*nothing was saved.*revoke.*tok_w1.*browser code/s);
		expect(fs.existsSync(tokenFile())).toBe(false);
		expect([...r.out, ...r.err].join("\n")).not.toContain("WORKER-TOKEN-VALUE");
	});

	it("accepts a browser or console token", async () => {
		withHub();
		for (const kind of ["browser", "console"]) {
			fs.rmSync(tokenFile(), { force: true });
			expect((await redeem({ json: { token: `T-${kind}`, tokenId: "tok_k", kind } })).code).toBe(0);
			expect(fs.readFileSync(tokenFile(), "utf8")).toBe(`T-${kind}`);
		}
	});

	it("names the hub's status for a bad or expired code and leaves an existing token file untouched", async () => {
		withHub();
		fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
		fs.writeFileSync(tokenFile(), "OLD-TOKEN", { mode: 0o600 });
		const r = await redeem({ status: 403, json: { error: "bad code" } });
		expect(r.code).toBe(1);
		expect(r.err.join("\n")).toMatch(/hub answered 403.*bad or expired.*wolfpack preview token/s);
		expect(fs.readFileSync(tokenFile(), "utf8")).toBe("OLD-TOKEN");
	});

	it("says there is no hub to pair with, before asking for a code", async () => {
		const r = await redeem();
		expect(r.code).toBe(1);
		expect(r.err.join("\n")).toMatch(/not paired with a hub/);
		expect(r.asked).toEqual([]);
	});

	it("refuses --code-stdin on a terminal instead of waiting for input that never comes", async () => {
		withHub();
		const out: string[] = [];
		const err: string[] = [];
		const asked: boolean[] = [];
		const r = await runPreview({ argv: ["token", "--code-stdin"], env: { HOME: home }, cwd: main, steps: { stdinIsTTY: () => true, readCode: async () => (asked.push(true), "X") }, log: (m: string) => out.push(m), warn: (m: string) => err.push(m) });
		expect(r.exitCode).toBe(1);
		expect(err.join("\n")).toMatch(/--code-stdin.*pipe/);
		expect(asked).toEqual([]);
	});

	it("when no code is given, points at the hub-host command, not at slot get", async () => {
		withHub();
		const r = await redeem({ code: null });
		expect(r.code).toBe(1);
		expect(r.err.join("\n")).toMatch(/no pairing code.*hub host/s);
		expect(r.err.join("\n")).not.toMatch(/slot get/);
		expect(r.calls).toEqual([]);
	});

	it("really reads the code from stdin and posts it to the hub over HTTP (the default steps)", async () => {
		const bodies: string[] = [];
		const srv = http.createServer((req, res) => {
			let b = "";
			req.on("data", (c) => (b += c));
			req.on("end", () => {
				bodies.push(`${req.method} ${req.url} ${b}`);
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ token: "E2E-TOKEN", tokenId: "tok_e2e" }));
			});
		});
		await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
		try {
			fs.mkdirSync(path.join(home, ".wolfpack", "workerd"), { recursive: true });
			fs.writeFileSync(path.join(home, ".wolfpack", "workerd", "hub.json"), JSON.stringify({ hubUrl: `http://127.0.0.1:${(srv.address() as import("node:net").AddressInfo).port}`, token: "W" }));
			const child = spawn(process.execPath, [path.resolve(__dirname, "runtime-preview.mjs"), "token", "--code-stdin"], { env: { ...process.env, HOME: home, WORKERD_CONFIG_DIR: path.join(home, ".wolfpack", "workerd") }, stdio: ["pipe", "pipe", "pipe"] });
			let out = "";
			let errText = "";
			child.stdout.on("data", (c) => (out += c));
			child.stderr.on("data", (c) => (errText += c));
			child.stdin.end("PIPED-CODE\n");
			const exit = await new Promise((r) => child.once("exit", r));
			expect({ exit, errText }).toEqual({ exit: 0, errText: "" });
			expect(out.trim()).toBe("saved hub token for preview slots (id tok_e2e)");
			expect(JSON.parse(bodies[0].split(" ").slice(2).join(" "))).toEqual({ code: "PIPED-CODE", label: `preview ${os.hostname()}` });
			expect(fs.readFileSync(tokenFile(), "utf8")).toBe("E2E-TOKEN");
		} finally {
			srv.close();
		}
	}, 30000);
});
