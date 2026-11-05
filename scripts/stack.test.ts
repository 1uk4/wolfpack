import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import * as stack from "./stack.mjs";
// @ts-expect-error plain .mjs script
import * as dev from "./dev-stack.mjs";

describe("stack args", () => {
	it("parses commands and flags", () => {
		expect(stack.parseArgs(["logs", "-f", "-n", "20"])).toEqual({ cmd: "logs", flags: { follow: true, lines: 20, yes: false, foreground: false } });
		expect(stack.parseArgs(["adopt", "--yes"]).flags.yes).toBe(true);
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
	it("builds the plist", () => {
		const x = stack.buildPlist(cfg, "/n/bin/node", "/n/bin:/usr/bin");
		expect(x).toContain("<string>/usr/bin/caffeinate</string>\n\t\t<string>-is</string>\n\t\t<string>/n/bin/node</string>");
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
		expect(stack.servicePath("/n/bin/node", ["/n/bin", "/x"], { HOME: "/h" }).split(":").slice(0, 3)).toEqual(["/n/bin", "/x", "/opt/homebrew/bin"]);
	});
});

describe("stack parsing and conflicts", () => {
	it("parses lsof and filters our own pid", () => {
		const l = stack.parseLsof("p123\ncnode\np456\ncother\n");
		expect(l).toEqual([{ pid: 123, command: "node" }, { pid: 456, command: "other" }]);
		expect(stack.portConflicts(l, 123)).toEqual([{ pid: 456, command: "other" }]);
		expect(stack.portConflicts(l, undefined)).toHaveLength(2);
		expect(stack.conflictMessage({ port: 7141 }, l)).toMatch(/adopt --yes/);
	});
	it("parses launchctl print", () => {
		expect(stack.parseLaunchctlPrint("\tstate = running\n\tpid = 42\n\tlast exit code = (never exited)\n")).toEqual({ state: "running", pid: 42, lastExit: "(never exited)" });
		expect(stack.parseLaunchctlPrint("").state).toBe("unknown");
	});
	it("walks the process tree", () => {
		const rows = stack.parsePs("  10 1 01:00 caffeinate\n  11 10 01:00 node workerd\n  12 11 00:10 wolfd\n  13 1 00:01 other\n");
		expect(stack.descendants(rows, 10).map((r: { pid: number }) => r.pid).sort()).toEqual([11, 12]);
		expect(stack.ancestors(rows, 12)).toEqual([11, 10]);
	});
});

describe("stack log rotation", () => {
	let tmp: string;
	beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stack-")); });
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
	it("rotates only past the cap", () => {
		const f = path.join(tmp, "s.log");
		fs.writeFileSync(f, "12345");
		stack.rotateLog(f, 10);
		expect(fs.existsSync(f)).toBe(true);
		stack.rotateLog(f, 3);
		expect(fs.existsSync(f)).toBe(false);
		expect(fs.existsSync(`${f}.1`)).toBe(true);
	});
});

describe("dev-stack", () => {
	let tmp: string;
	beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devstack-"))); });
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
	it("parses --app", () => {
		expect(dev.parseArgs([])).toEqual({ app: "console" });
		expect(dev.parseArgs(["--app", "none"])).toEqual({ app: "none" });
		expect(dev.parseArgs(["--app=desktop"])).toEqual({ app: "desktop" });
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
		expect(() => dev.resolveConfig({ ...e, DEV_CONSOLE_PORT: "7151" }, tmp)).toThrow(/must differ/);
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
