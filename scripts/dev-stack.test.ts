import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import * as dev from "./dev-stack.mjs";

describe("dev-stack", () => {
	let tmp: string;
	beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devstack-"))); });
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
	it("keeps sandbox paths, HOME and env inside the sandbox and strips live WOLF vars", () => {
		const cfg = dev.resolveConfig({ DEV_WOLVES_DIR: path.join(tmp, "w") }, tmp);
		const e = dev.childEnv(cfg, { WOLF_DEN: "/live", WOLFPACK_X: "1", WOLFPACK_MODELS_FILE: "/m.json", KEEP: "k", HOME: "/live" }, { WOLFPACK_Y: "2", ANTHROPIC_API_KEY: "sk" });
		expect(e).toMatchObject({ KEEP: "k", ANTHROPIC_API_KEY: "sk", WOLFPACK_MODELS_FILE: "/m.json" });
		expect(e.WOLF_DEN).toBeUndefined();
		expect(e.WOLFPACK_X).toBeUndefined();
		expect(e.WOLFPACK_Y).toBeUndefined();
		for (const p of [e.HOME, e.WORKERD_CONFIG_DIR]) expect(p.startsWith(cfg.wolves + path.sep)).toBe(true);
	});
	it("keeps pnpm's store and corepack's cache at the real home, so the sandbox HOME does not duplicate them", () => {
		const cfg = dev.resolveConfig({ DEV_WOLVES_DIR: path.join(tmp, "w") }, tmp);
		const e = dev.childEnv(cfg, {});
		for (const p of [e.PNPM_CONFIG_STORE_DIR, e.COREPACK_HOME]) {
			expect(p.startsWith(tmp + path.sep)).toBe(true);
			expect(p.startsWith(cfg.sandboxHome + path.sep)).toBe(false);
		}
		const explicit = dev.childEnv(cfg, { PNPM_CONFIG_STORE_DIR: "/my/store", COREPACK_HOME: "/my/corepack" });
		expect(explicit).toMatchObject({ PNPM_CONFIG_STORE_DIR: "/my/store", COREPACK_HOME: "/my/corepack" });
	});
	it("parses --app", () => {
		expect(dev.parseArgs([])).toEqual({ app: "console" });
		expect(dev.parseArgs(["--app", "none"])).toEqual({ app: "none" });
		expect(dev.parseArgs(["start", "--app", "none"])).toEqual({ app: "none", action: "start" });
		expect(dev.parseArgs(["stop"])).toEqual({ app: "console", action: "stop" });
		expect(dev.parseArgs(["--app", "none", "--sandbox", "/sb"])).toEqual({ app: "none", sandbox: "/sb" });
		expect(() => dev.parseArgs(["--app=desktop"])).toThrow(/must be one of/);
		expect(() => dev.parseArgs(["--app", "x"])).toThrow(/must be one of/);
		expect(() => dev.parseArgs(["--zzz"])).toThrow(/unknown option/);
	});
	it("refuses the live wolves folder, its parents, children and symlinks to it", () => {
		const home = path.join(tmp, "home");
		fs.mkdirSync(path.join(home, "wolves/local/1uk4"), { recursive: true });
		expect(() => dev.assertSandboxDir(path.join(home, "wolves/local"), home)).toThrow(/live wolves/);
		expect(() => dev.assertSandboxDir(path.join(home, "wolves/local/x"), home)).toThrow(/live wolves/);
		expect(() => dev.assertSandboxDir(path.join(home, "wolves"), home)).toThrow(/live wolves/);
		expect(() => dev.assertSandboxDir(home, home)).toThrow(/live wolves/);
		fs.symlinkSync(path.join(home, "wolves/local"), path.join(tmp, "link"));
		expect(() => dev.assertSandboxDir(path.join(tmp, "link/sub"), home)).toThrow(/live wolves/);
		expect(dev.assertSandboxDir(path.join(home, "wolves/dev-sandbox"), home)).toBe(path.join(home, "wolves/dev-sandbox"));
	});
	it("refuses live ports and equal ports", () => {
		const e = { DEV_WOLVES_DIR: path.join(tmp, "w") };
		expect(dev.resolveConfig(e, tmp)).toMatchObject({ workerdPort: 7151, consolePort: 3220 });
		expect(() => dev.resolveConfig({ ...e, DEV_WORKERD_PORT: "7141" }, tmp)).toThrow(/live-stack port/);
		// the live console (wolfpack preview) and the owner's agent slots 3231-3234
		for (const p of ["3230", "3231", "3234"]) expect(() => dev.resolveConfig({ ...e, DEV_CONSOLE_PORT: p }, tmp)).toThrow(/live-stack port/);
		expect(() => dev.resolveConfig({ ...e, DEV_CONSOLE_PORT: "7151" }, tmp)).toThrow(/must differ/);
	});
	/** A fake runner table: `live` holds the pids that are our runner (for `cfg` only); `sleep` adds up the waits instead of blocking. */
	function fakeRunner(cfg: object, opts: { dies?: "at-spawn" | "never" } = {}) {
		const live = new Set<number>();
		const spawned: { args: string[]; log: string }[] = [];
		const killed: [number, string][] = [];
		const out: string[] = [];
		let slept = 0;
		const deps = {
			spawnDetached: (args: string[], log: string) => (spawned.push({ args, log }), opts.dies === "at-spawn" || live.add(900), 900),
			isOurs: (pid: number, c: object) => c === cfg && live.has(pid),
			kill: (pid: number, sig: string) => (killed.push([pid, sig]), opts.dies === "never" || live.delete(pid)),
			sleep: (ms: number) => void (slept += ms),
			say: (m: string) => out.push(m),
		};
		return { deps, live, spawned, killed, out, slept: () => slept };
	}
	it("start runs detached with its pid and log inside the sandbox, marked with the sandbox dir; stop signals only its own runner", () => {
		const cfg = dev.resolveConfig({ DEV_WOLVES_DIR: path.join(tmp, "w") }, tmp);
		const r = fakeRunner(cfg);
		expect(dev.control("start", cfg, { app: "none" }, r.deps)).toMatchObject({ running: true, pid: 900 });
		expect(r.spawned).toHaveLength(1);
		expect(r.spawned[0].args).toEqual(["--app", "none", "--sandbox", cfg.wolves]);
		expect(r.spawned[0].log.startsWith(cfg.wolves + path.sep)).toBe(true);
		expect(dev.control("start", cfg, { app: "none" }, r.deps)).toMatchObject({ running: true, pid: 900 });
		expect(r.spawned).toHaveLength(1);
		expect(dev.control("status", cfg, {}, r.deps)).toMatchObject({ running: true, pid: 900 });
		expect(dev.control("stop", cfg, {}, r.deps)).toMatchObject({ running: false });
		expect(r.killed).toEqual([[900, "SIGTERM"]]);
		// a pid recorded earlier that now belongs to someone else is never signalled
		dev.control("start", cfg, { app: "none" }, r.deps);
		r.live.delete(900);
		expect(dev.control("stop", cfg, {}, r.deps)).toMatchObject({ running: false });
		expect(r.killed).toHaveLength(1);
		expect(dev.control("status", cfg, {}, r.deps)).toMatchObject({ running: false });
	});
	it("start reports a runner that dies at once and points to its log", () => {
		const cfg = dev.resolveConfig({ DEV_WOLVES_DIR: path.join(tmp, "w") }, tmp);
		const r = fakeRunner(cfg, { dies: "at-spawn" });
		const res = dev.control("start", cfg, { app: "none" }, r.deps);
		expect(res).toMatchObject({ running: false });
		expect(r.out.join("\n")).toContain(res.log);
		expect(r.out.join("\n")).toMatch(/exited/);
		expect(dev.control("status", cfg, {}, r.deps)).toMatchObject({ running: false });
	});
	it("stop waits at most 10 s, reports a runner that did not exit and keeps its pid file", () => {
		const cfg = dev.resolveConfig({ DEV_WOLVES_DIR: path.join(tmp, "w") }, tmp);
		const r = fakeRunner(cfg, { dies: "never" });
		dev.control("start", cfg, { app: "none" }, r.deps);
		const before = r.slept();
		expect(dev.control("stop", cfg, {}, r.deps)).toMatchObject({ running: true, pid: 900 });
		expect(r.slept() - before).toBe(10000);
		expect(r.out.at(-1)).toMatch(/still running/);
		expect(dev.control("status", cfg, {}, r.deps)).toMatchObject({ running: true, pid: 900 });
		r.live.delete(900);
		expect(dev.control("stop", cfg, {}, r.deps)).toMatchObject({ running: false });
	});
	it("the real isOurs accepts a runner of this sandbox and rejects one of another sandbox", async () => {
		const cfgA = dev.resolveConfig({ DEV_WOLVES_DIR: path.join(tmp, "a") }, tmp);
		const cfgB = dev.resolveConfig({ DEV_WOLVES_DIR: path.join(tmp, "b") }, tmp);
		// a node that only sleeps, carrying the runner's command line (dev-stack.mjs path + --sandbox <dir>) as its argv
		const self = fileURLToPath(new URL("./dev-stack.mjs", import.meta.url));
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", self, "--app", "none", "--sandbox", cfgA.wolves], { stdio: "ignore" });
		try {
			await new Promise((r) => child.once("spawn", r));
			const d = dev.realControlDeps();
			expect([d.isOurs(child.pid, cfgA), d.isOurs(child.pid, cfgB)]).toEqual([true, false]);
		} finally {
			child.kill("SIGKILL");
		}
	});
	it("scaffolds a wolf once, copying models.json", () => {
		const cfg = { wolves: path.join(tmp, "sb") };
		const models = path.join(tmp, "models.json");
		fs.writeFileSync(models, '{"transport":"subscription"}');
		const dir = dev.scaffold(cfg, models);
		expect(fs.readFileSync(path.join(dir, "wolf.yaml"), "utf8")).toMatch(/^name: sandbox$/m);
		expect(fs.existsSync(path.join(dir, "den"))).toBe(true);
		expect(fs.readFileSync(path.join(dir, "models.json"), "utf8")).toContain("subscription");
		expect(dev.scaffold(cfg, models)).toBeUndefined();
	});
});
