import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs script
import * as stack from "./stack.mjs";

describe("stack args", () => {
	it("parses commands and flags", () => {
		expect(stack.parseArgs(["logs", "-f", "-n", "20"])).toEqual({ cmd: "logs", flags: { follow: true, lines: 20 } });
	});
	it("rejects bad input", () => {
		expect(() => stack.parseArgs([])).toThrow(/usage/);
		expect(() => stack.parseArgs(["nope"])).toThrow(/unknown command/);
		expect(() => stack.parseArgs(["logs", "-n", "x"])).toThrow(/positive integer/);
		expect(() => stack.parseArgs(["start", "-f"])).toThrow(/unknown option/);
	});
});

describe("stack plist", () => {
	const cfg = stack.resolveConfig({}, "/Users/me", 501);
	it("defaults", () => {
		expect(cfg.label).toBe("com.wolfpack.stack");
		expect(cfg.port).toBe(7141);
		expect(cfg.plist).toBe("/Users/me/Library/LaunchAgents/com.wolfpack.stack.plist");
		expect(cfg.target).toBe("gui/501/com.wolfpack.stack");
		expect(cfg.runtime).toBe("/Users/me/wolves/local/runtime/wolfpack");
	});
	it("builds the plist, node loading the env file, node as job pid and holding no secrets", () => {
		const x = stack.buildPlist(cfg, "/n/bin/node", "/n/bin:/usr/bin");
		expect(x).toContain("<string>/bin/sh</string>");
		expect(x).toContain("caffeinate -is -w $$ &amp; exec");
		expect(x).toContain("<string>/n/bin/node</string>\n\t\t<string>--env-file-if-exists=/Users/me/.wolfpack/.env</string>");
		expect(x).not.toContain("<string>/usr/bin/caffeinate</string>");
		expect(x).not.toMatch(/ANTHROPIC|TOKEN|API_KEY/);
		expect(stack.resolveConfig({ WOLFPACK_HOME: "/w" }, "/Users/me", 501).envFile).toBe("/w/.env");
		expect(x).toContain("<string>--port</string>\n\t\t<string>7141</string>");
		expect(x).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		expect(x).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
		expect(x).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>15/);
		expect(x).toContain("<key>PATH</key>\n\t\t<string>/n/bin:/usr/bin</string>");
		expect(x).toContain("<key>StandardErrorPath</key>\n\t<string>/Users/me/wolves/local/logs/stack.log</string>");
	});
	it("escapes xml and honours overrides", () => {
		const c = stack.resolveConfig({ STACK_WOLVES: "/a&b", STACK_PORT: "7199", STACK_LABEL: "x.y" }, "/h", 1);
		expect(stack.buildPlist(c, "/n", "/p")).toContain("/a&amp;b");
		expect(c.port).toBe(7199);
		expect(() => stack.resolveConfig({ STACK_PORT: "0" })).toThrow(/bad STACK_PORT/);
	});
	it("puts node's dir first in PATH, deduped", () => {
		expect(stack.servicePath("/n/bin/node", ["/n/bin", "/x"], "/h").split(":").slice(0, 3)).toEqual(["/n/bin", "/x", "/opt/homebrew/bin"]);
	});
});

describe("stack parsing", () => {
	it("parses lsof and launchctl print", () => {
		expect(stack.parseLsof("p123\ncnode\np456\ncother\n")).toEqual([{ pid: 123, command: "node" }, { pid: 456, command: "other" }]);
		expect(stack.parseLaunchctlPrint("\tstate = running\n\tpid = 42\n\tlast exit code = (never exited)\n")).toEqual({ state: "running", pid: 42, lastExit: "(never exited)" });
		expect(stack.parseLaunchctlPrint("").state).toBe("unknown");
	});
	it("walks the process tree", () => {
		const rows = stack.parsePs("  10 1 01:00 caffeinate\n  11 10 01:00 node workerd\n  12 11 00:10 wolfd\n  13 1 00:01 other\n");
		expect(stack.descendants(rows, 10).map((r: { pid: number }) => r.pid).sort()).toEqual([11, 12]);
	});
	it("warns about a missing or group-readable env file", () => {
		const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stack-")), ".env");
		expect(stack.envFileWarning(f)).toMatch(/not found/);
		fs.writeFileSync(f, "A=1", { mode: 0o644 });
		fs.chmodSync(f, 0o644);
		expect(stack.envFileWarning(f)).toMatch(/chmod 600/);
		fs.chmodSync(f, 0o600);
		expect(stack.envFileWarning(f)).toBeUndefined();
	});
});

type Call = { cmd: string; args: string[] };
type Run = { status: number | null; stdout: string; stderr: string; error?: Error; signal?: string };
type MacState = { loaded?: boolean; running?: boolean; health?: object | "refused"; print?: Run; lsof?: Run };
/**
 * A fake Mac: launchctl/ps/lsof answered from `state`, every command and fetch recorded; fetch answers /healthz from
 * `state.health`. `state.print` / `state.lsof` override the launchctl print / lsof result (to fake a failure).
 */
function fakeMac(tmp: string, state: MacState) {
	const calls: Call[] = [];
	const fetched: string[] = [];
	const out: string[] = [];
	const spawned: Call[] = [];
	const runtime = path.join(tmp, "runtime");
	fs.mkdirSync(path.join(runtime, "packages/workerd/dist/bin"), { recursive: true });
	fs.writeFileSync(path.join(runtime, "packages/workerd/dist/bin/workerd.js"), "");
	const env = { STACK_WOLVES: path.join(tmp, "wolves"), STACK_RUNTIME: runtime, STACK_PLIST_DIR: path.join(tmp, "LaunchAgents"), WOLFPACK_HOME: path.join(tmp, "pack") };
	const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
	const deps = {
		home: tmp,
		uid: 501,
		platform: "darwin",
		nodePath: "/n/bin/node",
		nodeVersion: "22.23.3",
		say: (m: string) => void out.push(m),
		run: (cmd: string, args: string[]): Run => {
			calls.push({ cmd, args });
			if (cmd === "launchctl" && args[0] === "print") {
				if (state.print) return state.print;
				if (!state.loaded) return { status: 113, stdout: "", stderr: "Could not find service \"com.wolfpack.stack\" in domain for user gui: 501" };
				return ok(state.running ? "\tstate = running\n\tpid = 4242\n" : "\tstate = not running\n\tlast exit code = 1\n");
			}
			if (cmd === "launchctl") {
				if (args[0] === "bootstrap" || args[0] === "kickstart") Object.assign(state, { loaded: true, running: true });
				if (args[0] === "bootout") Object.assign(state, { loaded: false, running: false });
				return ok();
			}
			if (cmd === "ps") return ok(state.running ? "  4242 1 01:00 node workerd.js\n  4243 4242 00:59 node wolfd\n" : "");
			if (cmd === "lsof") return state.lsof ?? (state.running ? ok("p4242\ncnode\n") : { status: 1, stdout: "", stderr: "" });
			return ok();
		},
		spawnDetached: (cmd: string, args: string[]) => void spawned.push({ cmd, args }),
		fetch: async (url: string) => {
			fetched.push(url);
			if (state.health === undefined || state.health === "refused") throw new Error("connect ECONNREFUSED");
			return new Response(JSON.stringify(state.health), { status: 200 });
		},
	};
	const launchctl = () => calls.filter((c) => c.cmd === "launchctl" && c.args[0] !== "print").map((c) => c.args.join(" "));
	const ran = (cmd: string) => calls.some((c) => c.cmd === cmd);
	return { deps, env, calls, fetched, out, spawned, launchctl, ran, plist: path.join(env.STACK_PLIST_DIR, "com.wolfpack.stack.plist") };
}

describe("stack status: updates line", () => {
	it("flags an updater whose last check is older than two 30-minute timer intervals as stale; a recent check or no status file reads as before", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-au-"));
		try {
			const file = path.join(dir, "status.json");
			const now = Date.parse("2026-11-09T12:00:00.000Z");
			const status = (lastCheck: string) => JSON.stringify({ schema: 1, host: "mac", enabled: true, lastCheck, result: "ok", units: { stack: { component: "workerd", current: "0.1.5", target: "0.1.5", state: "idle" } } });
			fs.writeFileSync(file, status("2026-11-09T09:00:00.000Z")); // 3 h ago: the timer has missed 6 runs
			expect(stack.autoUpdateLine(file, now)).toMatch(/^stale \(last check 3h ago\)/);
			fs.writeFileSync(file, status("2026-11-09T11:35:00.000Z")); // 25 min ago: within one interval
			expect(stack.autoUpdateLine(file, now)).toBe("idle (running 0.1.5, stable 0.1.5); last check 2026-11-09T11:35:00.000Z");
			expect(stack.autoUpdateLine(path.join(dir, "missing.json"), now)).toBe("auto-update not set up (node scripts/auto-update-mac.mjs install)");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("stack verdict", () => {
	const online = { ok: true, wolves: [{ name: "a", state: "online" }] };
	const running = { state: "running", pid: 1 };
	const refused = { ok: false, wolves: [], error: "connect ECONNREFUSED" };
	it("maps the launchd state and the /healthz probe to one verdict", () => {
		const cases: [object | undefined, object, string | undefined, string][] = [
			[running, online, undefined, "healthy"],
			[running, { ok: true, wolves: [{ name: "a", state: "offline" }] }, undefined, "degraded"],
			[running, { ok: false, wolves: [] }, undefined, "degraded"],
			[running, refused, undefined, "unresponsive"],
			[{ state: "not running" }, refused, undefined, "down"],
			[undefined, online, undefined, "unmanaged"],
			[undefined, refused, undefined, "down"],
			[undefined, online, "launchctl print failed: Operation not permitted", "unknown"],
		];
		expect(cases.map(([svc, health, err]) => stack.verdict(svc, health, err))).toEqual(cases.map((c) => c[3]));
	});
});

describe("stack commands against a fake launchctl", () => {
	let tmp: string;
	beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stackcmd-"))); });
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("install writes a 0600 KeepAlive plist and never loads it, even when the service is loaded", async () => {
		const m = fakeMac(tmp, { loaded: false });
		await stack.main(["install"], m.env, m.deps);
		expect(fs.readFileSync(m.plist, "utf8")).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
		expect(fs.statSync(m.plist).mode & 0o777).toBe(0o600);
		const loaded = fakeMac(tmp, { loaded: true, running: true });
		await stack.main(["install"], loaded.env, loaded.deps);
		expect([...m.launchctl(), ...loaded.launchctl()]).toEqual([]);
	});

	it("start bootstraps a service that is not loaded, kickstarts a loaded one, and does nothing while it runs", async () => {
		const m = fakeMac(tmp, { loaded: false });
		await stack.main(["start"], m.env, m.deps);
		await stack.main(["start"], m.env, m.deps);
		expect(m.launchctl()).toEqual([`bootstrap gui/501 ${m.plist}`]);
		const idle = fakeMac(tmp, { loaded: true, running: false });
		await stack.main(["start"], idle.env, idle.deps);
		expect(idle.launchctl()).toEqual(["kickstart gui/501/com.wolfpack.stack"]);
	});

	it("restart hands off to a detached helper with the service target and pid, and changes nothing itself", async () => {
		const m = fakeMac(tmp, { loaded: true, running: true });
		await stack.main(["restart"], m.env, m.deps);
		expect(m.spawned).toHaveLength(1);
		expect(m.spawned[0].args.slice(-2)).toEqual(["gui/501/com.wolfpack.stack", "4242"]);
		expect(m.launchctl()).toEqual([]);
		// loaded but not running: nothing to signal, so it falls back to start (kickstart)
		const idle = fakeMac(tmp, { loaded: true, running: false });
		await stack.main(["restart"], idle.env, idle.deps);
		expect([idle.spawned, idle.launchctl()]).toEqual([[], ["kickstart gui/501/com.wolfpack.stack"]]);
	});

	it("stop is idempotent, and uninstall stops and removes the plist", async () => {
		const m = fakeMac(tmp, { loaded: true, running: true });
		await stack.main(["stop"], m.env, m.deps);
		await stack.main(["stop"], m.env, m.deps);
		expect(m.launchctl()).toEqual(["bootout gui/501/com.wolfpack.stack"]);
		await stack.main(["install"], m.env, m.deps);
		await stack.main(["start"], m.env, m.deps);
		await stack.main(["uninstall"], m.env, m.deps);
		expect(m.launchctl().slice(-2)).toEqual([`bootstrap gui/501 ${m.plist}`, "bootout gui/501/com.wolfpack.stack"]);
		expect(fs.existsSync(m.plist)).toBe(false);
	});

	it("logs passes -f and -n through to tail on the stack log", async () => {
		const m = fakeMac(tmp, { loaded: false });
		const log = path.join(m.env.STACK_WOLVES, "logs/stack.log");
		fs.mkdirSync(path.dirname(log), { recursive: true });
		fs.writeFileSync(log, "x\n");
		await stack.main(["logs", "-f", "-n", "5"], m.env, m.deps);
		expect(m.calls.at(-1)).toEqual({ cmd: "tail", args: ["-f", "-n", "5", log] });
	});

	it("start refuses when something else holds the port", async () => {
		const m = fakeMac(tmp, { loaded: false, lsof: { status: 0, stdout: "p999\nchand-started\n", stderr: "" } });
		await expect(stack.main(["start"], m.env, m.deps)).rejects.toThrow(/in use by hand-started \(pid 999\)/);
		expect(m.launchctl()).toEqual([]);
	});

	it("start fails on an lsof error instead of reading it as a free port", async () => {
		const bad = fakeMac(tmp, { loaded: false, lsof: { status: 2, stdout: "", stderr: "lsof: unacceptable port specification" } });
		await expect(stack.main(["start"], bad.env, bad.deps)).rejects.toThrow(/lsof failed: lsof: unacceptable port specification/);
		const missing = fakeMac(tmp, { loaded: false, lsof: { status: null, stdout: "", stderr: "", error: new Error("spawnSync lsof ENOENT") } });
		await expect(stack.main(["start"], missing.env, missing.deps)).rejects.toThrow(/lsof failed: spawnSync lsof ENOENT/);
		expect([...bad.launchctl(), ...missing.launchctl()]).toEqual([]);
	});

	it("a launchctl print failure other than not-found is an error, not 'not loaded'", async () => {
		const print = { status: 5, stdout: "", stderr: "Operation not permitted" };
		const m = fakeMac(tmp, { print, health: "refused" });
		await expect(stack.main(["start"], m.env, m.deps)).rejects.toThrow(/launchctl print failed: Operation not permitted/);
		expect(m.launchctl()).toEqual([]);
		const r = await stack.main(["status"], m.env, m.deps);
		expect(r).toMatchObject({ code: 1, status: { verdict: "unknown", reason: "launchctl print failed: Operation not permitted", service: undefined } });
	});

	it("status probes /healthz on 127.0.0.1:<port> and exits 0 only when healthy", async () => {
		const online = { ok: true, wolves: [{ name: "a", state: "online" }] };
		const m = fakeMac(tmp, { loaded: true, running: true, health: online });
		const r = await stack.main(["status"], m.env, m.deps);
		expect(m.fetched).toEqual(["http://127.0.0.1:7141/healthz"]);
		expect(r).toMatchObject({ code: 0, status: { verdict: "healthy", service: { state: "running", pid: 4242 }, health: online, port: { listeners: [{ pid: 4242, command: "node" }] } } });
		const u = fakeMac(tmp, { loaded: false, health: online });
		expect(await stack.main(["status"], u.env, u.deps)).toMatchObject({ code: 1, status: { verdict: "unmanaged", service: undefined } });
		expect(u.out.join("\n")).toMatch(/no restart on crash/);
	});

	it("status with a silent say and brief prints nothing, skips ps and the log tail, and still returns the verdict", async () => {
		const m = fakeMac(tmp, { loaded: true, running: true, health: "refused", lsof: { status: 2, stdout: "", stderr: "lsof: boom" } });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const r = await stack.main(["status"], m.env, { ...m.deps, say: () => {} }, { brief: true });
			expect(r).toMatchObject({ code: 1, status: { verdict: "unresponsive", port: { error: "lsof failed: lsof: boom" } } });
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
		expect([m.ran("ps"), m.ran("tail")]).toEqual([false, false]);
	});
});
