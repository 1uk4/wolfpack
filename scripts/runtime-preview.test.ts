import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { runPreview } from "./runtime-preview.mjs";
// @ts-expect-error plain .mjs script
import { runSwitch } from "./runtime-preview-switch.mjs";

let tmp: string, home: string, main: string, rtWt: string, origin: string, featSha: string;
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const commit = (cwd: string, file: string, body: string) => {
	fs.writeFileSync(path.join(cwd, file), body);
	g(cwd, "add", file);
	g(cwd, "commit", "-q", "-m", `edit ${file}`);
};
const stateFile = () => path.join(home, ".wolfpack", "preview", "state.json");
const ud = () => path.join(tmp, "Application Support");
const consoleJson = (name: string) => path.join(ud(), name, "console.json");
const readConsoleJson = (name: string) => JSON.parse(fs.readFileSync(consoleJson(name), "utf8"));
/** A worktree-like dir with apps/console and a fake next bin. */
const devDir = (name: string) => {
	const d = path.join(tmp, name);
	fs.mkdirSync(path.join(d, "apps", "console", "node_modules", "next", "dist", "bin"), { recursive: true });
	fs.writeFileSync(path.join(d, "apps", "console", "node_modules", "next", "dist", "bin", "next"), "//");
	return d;
};
const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rtprev-")));
	home = path.join(tmp, "home");
	fs.mkdirSync(home);
	fs.mkdirSync(path.join(tmp, "Application Support", "LearnHarness"), { recursive: true });
	fs.writeFileSync(path.join(tmp, "Application Support", "LearnHarness", "console.json"), JSON.stringify({ consoleUrl: "https://sfo-01.example", theme: "dark" }));
	origin = path.join(tmp, "origin.git");
	g(tmp, "init", "-q", "--bare", "-b", "main", origin);
	main = path.join(tmp, "main");
	g(tmp, "init", "-q", "-b", "main", main);
	g(main, "config", "user.email", "t@t");
	g(main, "config", "user.name", "t");
	g(main, "remote", "add", "origin", origin);
	commit(main, "a.txt", "a");
	g(main, "branch", "stable");
	g(main, "checkout", "-q", "-b", "feat/x");
	commit(main, "b.txt", "b");
	featSha = g(main, "rev-parse", "HEAD");
	g(main, "checkout", "-q", "main");
	g(main, "push", "-q", "origin", "stable", "feat/x");
	rtWt = path.join(tmp, "rt");
	g(main, "worktree", "add", "-q", rtWt, "stable");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Stubbed steps record into `calls`; the git runner is real but spied on. */
const harness = (opts: { buildFails?: boolean; checkoutFails?: boolean; noWolves?: boolean; portBusy?: boolean } = {}) => {
	const lc: string[][] = [];
	const calls: string[] = [];
	const gitCalls: string[][] = [];
	const logs: string[] = [];
	const builds: (string | undefined)[] = [];
	const steps = {
		git: (cwd: string, ...args: string[]) => {
			gitCalls.push(args);
			if (opts.checkoutFails && args[0] === "checkout" && args[1] === "--detach") throw new Error("checkout refused");
			if (args[0] === "checkout") calls.push(`git ${args.join(" ")}`);
			return g(cwd, ...args);
		},
		build: (wt: string, o?: { logFile?: string }) => {
			builds.push(o?.logFile);
			calls.push(`build@${g(wt, "rev-parse", "HEAD")}`);
			if (opts.buildFails && g(wt, "rev-parse", "HEAD") === featSha) throw new Error("boom");
		},
		spawnHelper: (a: { args: string[] }) => calls.push(`helper ${a.args.slice(4).join(" ")}`),
		launchctl: (...a: string[]) => (lc.push(a), 0),
		confirm: async () => true,
		pick: async () => "all",
		sleep: async () => {},
		portFree: async () => !opts.portBusy,
		fetchJson: async (u: string) => (u.endsWith("/api/wolves") ? { wolves: opts.noWolves ? [] : [{ id: "ddkyhT", name: "1uk4", host: "local", status: "busy", librarian: false, kbReadable: true }] } : { chats: [] }),
	};
	const run = (argv: string[]) =>
		runPreview({ argv, env: { HOME: home, WOLVES_DIR: path.join(tmp, "wolves"), PREVIEW_USERDATA_ROOT: ud() }, cwd: rtWt, steps, log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) });
	return { calls, gitCalls, logs, run, steps, builds, lc };
};

describe("runtime-preview", () => {
	it("on: records state, then checks out, builds and only then launches the switch helper", async () => {
		const h = harness();
		const stableSha = g(rtWt, "rev-parse", "HEAD");
		const r = await h.run(["feat/x"]);
		expect(r.exitCode).toBe(0);
		expect(h.calls).toEqual([`git checkout --detach ${featSha}`, `build@${featSha}`, "helper running 0"]);
		expect(readState()).toMatchObject({ previousRef: stableSha, previousBranch: "stable", previewRef: "feat/x", previewSha: featSha, phase: "switching" });
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(featSha);
	});

	it("on: refuses a dirty runtime and an option-looking ref, changing nothing", async () => {
		const h = harness();
		fs.writeFileSync(path.join(rtWt, "a.txt"), "dirty");
		expect((await h.run(["feat/x"])).exitCode).toBe(1);
		expect(fs.existsSync(stateFile())).toBe(false);
		g(rtWt, "checkout", "-q", "--", "a.txt");

		expect((await h.run(["-x"])).exitCode).toBe(1); // a ref that looks like an option
	});

	it("on: a failed build never launches the helper, restores the previous ref and ends build-failed", async () => {
		const h = harness({ buildFails: true });
		const stableSha = g(rtWt, "rev-parse", "HEAD");
		const r = await h.run(["feat/x"]);
		expect(r.exitCode).toBe(1);
		expect(h.calls.some((c) => c.startsWith("helper"))).toBe(false);
		expect(g(rtWt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("stable");
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(stableSha);
		expect(h.calls.at(-1)).toBe(`build@${stableSha}`);
		expect(readState().phase).toBe("build-failed");
	});

	it("on: a failed checkout restores the prior state, and removes it only when there was none", async () => {
		await harness().run(["feat/x"]);
		const before = fs.readFileSync(stateFile(), "utf8");
		expect((await harness({ checkoutFails: true }).run(["feat/x"])).exitCode).toBe(1);
		expect(fs.readFileSync(stateFile(), "utf8")).toBe(before);
		fs.rmSync(stateFile());
		expect((await harness({ checkoutFails: true }).run(["feat/x"])).exitCode).toBe(1);
		expect(fs.existsSync(stateFile())).toBe(false);
	});

	it("on: after a build-failed whose restore left HEAD on the preview, previous ref and branch still come from the state", async () => {
		const h = harness({ buildFails: true });
		const stableSha = g(rtWt, "rev-parse", "HEAD");
		await h.run(["feat/x"]); // build-failed state, previous = stable
		g(rtWt, "checkout", "-q", "--detach", featSha); // the failed restore left the runtime on the preview
		await harness().run(["feat/x"]);
		expect(readState()).toMatchObject({ previousRef: stableSha, previousBranch: "stable", phase: "switching" });
	});

	it("off: recovers from the state file alone after a crash mid-switch", async () => {
		const h = harness();
		const stableSha = g(rtWt, "rev-parse", "HEAD");
		await h.run(["feat/x"]);
		h.calls.length = 0;
		const s = readState();
		fs.writeFileSync(stateFile(), JSON.stringify({ ...s, phase: "building" })); // the process died before the helper ran
		const r = await harness().run(["off"]); // fresh process: no memory of the first run
		expect(r.exitCode).toBe(0);
		expect(g(rtWt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("stable");
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(stableSha);
	});

	it("off: builds stable, then launches the helper to restart and clear the state", async () => {
		const h = harness();
		await h.run(["feat/x"]);
		h.calls.length = 0;
		await h.run(["off"]);
		expect(h.calls).toEqual(["git checkout stable", expect.stringMatching(/^build@/), "helper stable 1"]);
	});

	it("off fast-forwards stable to a newer origin/stable; the only merge is --ff-only and nothing is pushed", async () => {
		const h = harness();
		await h.run(["feat/x"]);
		// The owner merged a release meanwhile: origin/stable is one commit ahead of the runtime's stable.
		const clone = path.join(tmp, "owner");
		g(tmp, "clone", "-q", "-b", "stable", origin, clone);
		g(clone, "config", "user.email", "o@o");
		g(clone, "config", "user.name", "o");
		commit(clone, "c.txt", "c");
		g(clone, "push", "-q", "origin", "stable");
		const originSha = g(clone, "rev-parse", "HEAD");
		expect(g(rtWt, "rev-parse", "stable")).not.toBe(originSha);
		await h.run(["off"]);
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(originSha);
		expect(g(rtWt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("stable");
		expect(h.gitCalls.filter((a) => a[0] === "merge")).toEqual([["merge", "--ff-only", "origin/stable"]]);
		expect(h.gitCalls.map((a) => a[0])).not.toContain("push");
	});

	it("--dry-run prints the plan and changes nothing, for on and for off of an active preview", async () => {
		const h = harness();
		const stableSha = g(rtWt, "rev-parse", "HEAD");
		expect((await h.run(["feat/x", "--dry-run"])).exitCode).toBe(0);
		expect(h.calls).toEqual([]);
		expect(fs.existsSync(stateFile())).toBe(false);
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(stableSha);

		await h.run(["feat/x"]); // a real preview is now active
		h.calls.length = 0;
		const before = fs.readFileSync(stateFile(), "utf8");
		expect((await h.run(["off", "--dry-run"])).exitCode).toBe(0);
		expect(h.calls).toEqual([]);
		expect(fs.readFileSync(stateFile(), "utf8")).toBe(before);
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(featSha);
		expect(h.logs.join("\n")).toContain("[dry-run]");
	});

	it("on: a local ref ahead of origin wins over the stale origin/<ref>, with a warning", async () => {
		g(main, "checkout", "-q", "feat/x");
		commit(main, "c.txt", "c");
		const localSha = g(main, "rev-parse", "HEAD");
		g(main, "checkout", "-q", "main");
		const h = harness();
		await h.run(["feat/x"]);
		expect(readState().previewSha).toBe(localSha);
		expect(h.logs.join("\n")).toContain("ahead of origin");
	});

	it("on: a detached runtime is found by its known path and its previous branch defaults to RUNTIME_BRANCH", async () => {
		g(main, "worktree", "remove", "--force", rtWt);
		const known = path.join(tmp, "wolves", "runtime", "wolfpack");
		g(main, "worktree", "add", "-q", "--detach", known, "stable");
		const h = harness();
		const r = await runPreview({ argv: ["feat/x"], env: { HOME: home, WOLVES_DIR: path.join(tmp, "wolves") }, cwd: main, steps: { ...h.steps }, log: () => {}, warn: () => {} });
		expect(r.exitCode).toBe(0);
		expect(readState()).toMatchObject({ previousBranch: "stable", runtimeDir: known });
	});

	it("on: build output goes to last-run.log, the terminal gets one progress line", async () => {
		const h = harness();
		await h.run(["feat/x"]);
		expect(h.builds).toEqual([path.join(home, ".wolfpack", "preview", "last-run.log")]);
		expect(h.logs.filter((l) => l.includes("building")).length).toBe(1);
	});

	it("status --json prints the state, the console url and the last log lines", async () => {
		const h = harness();
		await h.run(["feat/x"]);
		fs.writeFileSync(path.join(home, ".wolfpack", "preview", "last-run.log"), "one\ntwo\n");
		h.logs.length = 0;
		await h.run(["status", "--json"]);
		const out = JSON.parse(h.logs.join("\n"));
		expect(out).toMatchObject({ state: { previewRef: "feat/x", phase: "switching" }, consoleUrl: "http://127.0.0.1:3230", console: { mode: "build", missing: false }, log: ["one", "two"] });
	});

	it("off works from the stable copy under ~/.wolfpack/preview/bin when the runtime tree has no preview script", async () => {
		const h = harness();
		const stableSha = g(rtWt, "rev-parse", "HEAD");
		await h.run(["feat/x"]);
		expect(fs.existsSync(path.join(rtWt, "scripts", "runtime-preview.mjs"))).toBe(false); // the previewed tree predates the command
		const copy = path.join(home, ".wolfpack", "preview", "bin", "runtime-preview.mjs");
		const mod = await import(`${copy}?copy`);
		const r = await mod.runPreview({ argv: ["off"], env: { HOME: home }, cwd: rtWt, steps: h.steps, log: () => {}, warn: () => {} });
		expect(r.exitCode).toBe(0);
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(stableSha);
	});

	it("off --rollback (used by the helper) checks out and builds the previous ref but launches no helper and keeps the state", async () => {
		const h = harness();
		const stableSha = g(rtWt, "rev-parse", "HEAD");
		await h.run(["feat/x"]);
		h.calls.length = 0;
		expect((await h.run(["off", "--rollback"])).exitCode).toBe(0);
		expect(h.calls).toEqual(["git checkout stable", `build@${stableSha}`]);
		expect(readState()).toMatchObject({ previewRef: "feat/x" });
	});

	it("on: records the local console port (PREVIEW_CONSOLE_PORT, default 3230) for the helper and says to reopen the app", async () => {
		const h = harness();
		await h.run(["feat/x"]);
		expect(readState().consolePort).toBe(3230);
		expect(h.logs.join("\n")).toContain("local console on http://127.0.0.1:3230");
		fs.rmSync(stateFile());
		g(rtWt, "checkout", "-q", "stable");
		await runPreview({ argv: ["feat/x"], env: { HOME: home, PREVIEW_CONSOLE_PORT: "3999", WOLVES_DIR: path.join(tmp, "wolves") }, cwd: rtWt, steps: h.steps, log: () => {}, warn: () => {} });
		expect(readState().consolePort).toBe(3999);
	});

	it("off with a local stable ahead of origin/stable warns and stays on the local stable", async () => {
		g(rtWt, "checkout", "-q", "stable");
		commit(rtWt, "local.txt", "x"); // 1 commit ahead of origin/stable
		const aheadSha = g(rtWt, "rev-parse", "HEAD");
		const h = harness();
		await h.run(["feat/x"]);
		h.logs.length = 0;
		expect((await h.run(["off"])).exitCode).toBe(0);
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(aheadSha);
		expect(h.logs.join("\n")).toContain("ahead of origin/stable");
	});

	it("on, helper, on again, helper, off ends with the owner's original consoleUrl", async () => {
		const ud = path.join(tmp, "Application Support");
		fs.mkdirSync(path.join(ud, "LearnHarness"), { recursive: true });
		const cj = path.join(ud, "LearnHarness", "console.json");
		fs.writeFileSync(cj, JSON.stringify({ consoleUrl: "https://sfo-01.example" }));
		const app = path.join(rtWt, "apps", "console");
		fs.mkdirSync(path.join(app, ".next", "standalone", "apps", "console"), { recursive: true });
		fs.writeFileSync(path.join(app, ".next", "standalone", "apps", "console", "server.js"), "//");
		const plist = path.join(tmp, "stack.plist");
		fs.writeFileSync(plist, "<plist/>");
		const h = harness();
		const helper = (clear: boolean) =>
			runSwitch({
				stateFile: stateFile(), plist, label: "com.wolfpack.stack", port: "7141", okPhase: "running", clear, uid: 501,
				launchctl: () => 0, sleep: async () => {}, health: async () => true, log: () => {}, portFree: async () => true,
				localConsole: { port: "3230", home, userDataRoot: ud, runtimeDir: rtWt, node: "/usr/bin/node" },
				deep: { consoleUrl: "http://127.0.0.1:3230" }, rollback: async () => true,
				fetchJson: async (u: string) => (u.endsWith("/api/wolves") ? { wolves: [{ id: "ddkyhT", name: "1uk4" }] } : { chats: [] }),
			});
		await h.run(["feat/x"]);
		await helper(false);
		await h.run(["feat/x"]); // a repeat on of the active ref rewrites the state file
		await helper(false);
		await helper(true); // off
		expect(JSON.parse(fs.readFileSync(cj, "utf8")).consoleUrl).toBe("https://sfo-01.example");
	});

	it("status with no state says stable, no preview", async () => {
		const h = harness();
		await h.run(["status"]);
		expect(h.logs.join("\n")).toContain("stable, no preview");
	});

	describe("preview dev", () => {
		const plistText = () => fs.readFileSync(path.join(home, "Library", "LaunchAgents", "com.wolfpack.preview-console.plist"), "utf8");

		it("refuses a dir without apps/console or without node_modules, hints pnpm install, and changes nothing", async () => {
			const h = harness();
			expect((await h.run(["dev", path.join(tmp, "nope")])).exitCode).toBe(1);
			const noModules = path.join(tmp, "nm");
			fs.mkdirSync(path.join(noModules, "apps", "console"), { recursive: true });
			expect((await h.run(["dev", noModules])).exitCode).toBe(1);
			expect(h.logs.join("\n")).toContain("pnpm install");
			expect(h.lc).toEqual([]);
			expect(fs.existsSync(stateFile())).toBe(false);
		});

		it("serves next dev from the worktree under the preview-console agent, then points the app and records the original first", async () => {
			const h = harness();
			const d = devDir("wt");
			expect((await h.run(["dev", d])).exitCode).toBe(0);
			const t = plistText();
			const app = path.join(fs.realpathSync(d), "apps", "console");
			expect(t).toContain(`<string>${path.join(app, "node_modules", "next", "dist", "bin", "next")}</string><string>dev</string>`);
			expect(t).toContain(`<key>WorkingDirectory</key><string>${app}</string>`);
			expect(t).toContain("<key>WOLFPACK_API_URL</key><string>http://127.0.0.1:7141</string>");
			expect(t).toContain("<key>HOSTNAME</key><string>127.0.0.1</string>");
			expect(t).toContain("<key>PORT</key><string>3230</string>");
			expect(readConsoleJson("LearnHarness")).toEqual({ consoleUrl: "http://127.0.0.1:3230", theme: "dark" });
			expect(readState()).toMatchObject({ console: { mode: "dev", dir: fs.realpathSync(d) }, consolePort: 3230, apps: [{ previous: "https://sfo-01.example" }] });
			// the wolves are never touched
			expect(h.lc.every((a) => a.join(" ").includes("preview-console") || a[0] === "bootstrap" && String(a[2]).includes("preview-console"))).toBe(true);
			expect(h.gitCalls.filter((a) => a[0] === "checkout")).toEqual([]);
			expect(h.calls).toEqual([]);
		});

		it("defaults to the git worktree containing cwd", async () => {
			const h = harness();
			fs.mkdirSync(path.join(rtWt, "apps", "console", "node_modules", "next", "dist", "bin"), { recursive: true });
			fs.writeFileSync(path.join(rtWt, "apps", "console", "node_modules", "next", "dist", "bin", "next"), "//");
			expect((await h.run(["dev"])).exitCode).toBe(0);
			expect(readState().console.dir).toBe(rtWt);
		});

		it("fails when no wolf is listed in time: the agent is stopped, the app untouched and the state removed", async () => {
			const h = harness({ noWolves: true });
			expect((await h.run(["dev", devDir("wt")])).exitCode).toBe(1);
			expect(readConsoleJson("LearnHarness").consoleUrl).toBe("https://sfo-01.example");
			expect(h.lc.at(-1)).toEqual(["bootout", `gui/${process.getuid?.()}/com.wolfpack.preview-console`]);
			expect(fs.existsSync(stateFile())).toBe(false);
		});

		it("dev in another dir while one is active re-points the agent and keeps apps with the original url", async () => {
			const h = harness();
			await h.run(["dev", devDir("wt1")]);
			expect((await h.run(["dev", devDir("wt2")])).exitCode).toBe(0);
			expect(plistText()).toContain(`<key>WorkingDirectory</key><string>${path.join(fs.realpathSync(tmp), "wt2", "apps", "console")}</string>`);
			expect(readState()).toMatchObject({ console: { mode: "dev", dir: path.join(fs.realpathSync(tmp), "wt2") }, apps: [{ previous: "https://sfo-01.example" }] });
			expect(readConsoleJson("LearnHarness")).toEqual({ consoleUrl: "http://127.0.0.1:3230", theme: "dark" });
		});

		it("dev run again in the same dir is a restart: agent reloaded, state and apps unchanged", async () => {
			const h = harness();
			await h.run(["dev", devDir("wt1")]);
			const before = readState();
			h.lc.length = 0;
			expect((await h.run(["dev", devDir("wt1")])).exitCode).toBe(0);
			expect(h.lc.map((a) => a[0])).toContain("bootstrap");
			expect(readState()).toEqual(before);
		});

		it("on a new ref while another ref preview is active switches in place, keeping previousRef, previousBranch and apps", async () => {
			const h = harness();
			const stableSha = g(rtWt, "rev-parse", "HEAD");
			await h.run(["feat/x"]);
			const first = readState();
			h.calls.length = 0;
			g(main, "branch", "feat/y", "stable");
			g(main, "push", "-q", "origin", "feat/y");
			expect((await h.run(["feat/y"])).exitCode).toBe(0);
			expect(readState()).toMatchObject({ previousRef: stableSha, previousBranch: "stable", previewRef: "feat/y", phase: "switching", startedAt: expect.any(String) });
			expect(readState().previousRef).toBe(first.previousRef);
			expect(h.calls.at(-1)).toBe("helper running 0");
		});

		it("on with a dev console active keeps the dev console and its apps, and takes the previous ref from HEAD", async () => {
			const h = harness();
			const stableSha = g(rtWt, "rev-parse", "HEAD");
			await h.run(["dev", devDir("wt1")]);
			const apps = readState().apps;
			expect((await h.run(["feat/x"])).exitCode).toBe(0);
			expect(readState()).toMatchObject({ previousRef: stableSha, previousBranch: "stable", previewRef: "feat/x", console: { mode: "dev" }, apps });
		});

		it("off with only a dev console stops the agent, restores the app and clears the state, never touching the wolves", async () => {
			const h = harness();
			await h.run(["dev", devDir("wt1")]);
			h.lc.length = 0;
			h.gitCalls.length = 0;
			expect((await h.run(["off"])).exitCode).toBe(0);
			expect(h.lc.map((a) => a.join(" ").replace(/gui\/\d+/, "gui/U"))).toEqual(["bootout gui/U/com.wolfpack.preview-console"]);
			expect(h.gitCalls.filter((a) => a[0] === "checkout" || a[0] === "merge")).toEqual([]);
			expect(h.calls).toEqual([]);
			expect(readConsoleJson("LearnHarness")).toEqual({ consoleUrl: "https://sfo-01.example", theme: "dark" });
			expect(fs.existsSync(stateFile())).toBe(false);
			expect(fs.existsSync(path.join(home, "Library", "LaunchAgents", "com.wolfpack.preview-console.plist"))).toBe(false);
		});

		it("off with a ref preview and a dev console restores the ref via the helper, which also stops the console", async () => {
			const h = harness();
			await h.run(["dev", devDir("wt1")]);
			await h.run(["feat/x"]);
			h.calls.length = 0;
			expect((await h.run(["off"])).exitCode).toBe(0);
			expect(h.calls).toEqual(["git checkout stable", expect.stringMatching(/^build@/), "helper stable 1"]);
		});

		it("status and status --json show the dev mode and dir, and flag a deleted dir with the fix command", async () => {
			const h = harness();
			const d = devDir("wt1");
			await h.run(["dev", d]);
			h.logs.length = 0;
			await h.run(["status"]);
			expect(h.logs.join("\n")).toContain(`dev console from ${fs.realpathSync(d)}`);
			fs.rmSync(d, { recursive: true });
			h.logs.length = 0;
			await h.run(["status", "--json"]);
			expect(JSON.parse(h.logs.join("\n"))).toMatchObject({ consoleUrl: "http://127.0.0.1:3230", console: { mode: "dev", dir: fs.realpathSync(tmp) + "/wt1", missing: true } });
			h.logs.length = 0;
			await h.run(["status"]);
			expect(h.logs.join("\n")).toMatch(/no longer exists[\s\S]*wolfpack preview dev/);
		});

		it("off --dry-run of a dev console prints the plan and changes nothing", async () => {
			const h = harness();
			await h.run(["dev", devDir("wt1")]);
			h.lc.length = 0;
			const before = fs.readFileSync(stateFile(), "utf8");
			expect((await h.run(["off", "--dry-run"])).exitCode).toBe(0);
			expect(h.lc).toEqual([]);
			expect(fs.readFileSync(stateFile(), "utf8")).toBe(before);
		});

		it("fails with the reason when the port is held by something else, starting nothing", async () => {
			const h = harness({ portBusy: true });
			expect((await h.run(["dev", devDir("wt")])).exitCode).toBe(1);
			expect(h.logs.join("\n")).toContain("3230");
			expect(h.lc.some((a) => a[0] === "bootstrap")).toBe(false);
		});
	});
});
