import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { bundleState, main, planExtensionInstalls, runPlans } from "./dev-stack-extensions.mjs";

const REPO_REAL = path.resolve(__dirname, "..");
const engine = await import(pathToFileURL(path.join(REPO_REAL, "packages/engine/dist/index.js")).href);
const extensions = [{ key: "memory", dir: "wolfpack-memory" }, { key: "ask", dir: "ask-user-question" }];

let tmp: string;
let repo: string;
let home: string;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devstack-ext-")));
	repo = path.join(tmp, "repo");
	home = path.join(tmp, "home");
	fs.mkdirSync(home);
	touch(path.join(repo, "extensions/wolfpack-memory/index.ts"), 1_000_000);
	touch(path.join(repo, "extensions/wolfpack-memory/index.test.ts"), 9_000_000); // tests never invalidate
	touch(path.join(repo, "packages/engine/src/a.ts"), 1_000_000);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function touch(p: string, mtimeMs: number, body = "x") {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
	fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}
const wolvesDir = () => path.join(tmp, "wolves");
const wolf = (dir: string, yaml: string) => touch(path.join(wolvesDir(), dir, "wolf.yaml"), 1, yaml);
const bundle = (den: string, mtime: number) => touch(path.join(den, "extensions/wolfpack-memory/index.js"), mtime);
const sandboxRoot = (root: string, kind: "shared" | "single") => {
	touch(path.join(root, "snapshot.json"), 1);
	fs.mkdirSync(path.join(root, kind === "shared" ? "dens" : "den"), { recursive: true });
};
const plan = () => planExtensionInstalls({ wolvesDir: wolvesDir(), repo, engine, extensions, home });
const only = (name: string) => plan().find((p: { wolf: string }) => p.wolf === name);

describe("bundleState", () => {
	it("missing / stale / fresh by mtime against the source roots", () => {
		const roots = [path.join(repo, "extensions/wolfpack-memory"), path.join(repo, "packages/engine/src")];
		const b = path.join(tmp, "b/index.js");
		expect(bundleState(b, roots)).toBe("missing");
		touch(b, 500_000);
		expect(bundleState(b, roots)).toBe("stale");
		touch(b, 2_000_000);
		expect(bundleState(b, roots)).toBe("fresh");
		touch(path.join(repo, "packages/engine/src/b.ts"), 3_000_000);
		expect(bundleState(b, roots)).toBe("stale");
	});
});

describe("planExtensionInstalls (sandbox resolution mirrors the engine)", () => {
	it("sandbox: true -> <wolfdir>/sandbox", () => {
		const root = path.join(wolvesDir(), "t", "sandbox");
		wolf("t", "name: t\nextensions: [memory]\nsandbox: true\n");
		sandboxRoot(root, "shared");
		const p = only("t");
		expect(p).toMatchObject({ action: "install", sandboxRoot: root, shared: true, den: path.join(root, "dens/t") });
	});
	it("expands ~ against the home option", () => {
		const root = path.join(home, "sb");
		wolf("t", "name: t\nextensions: [memory]\nsandbox:\n  root: ~/sb\n");
		sandboxRoot(root, "shared");
		expect(only("t")).toMatchObject({ sandboxRoot: root });
	});
	it("resolves a relative root against the wolf's dir", () => {
		const root = path.join(wolvesDir(), "t", "rel");
		wolf("t", "name: t\nextensions: [memory]\nsandbox:\n  root: rel\n");
		sandboxRoot(root, "shared");
		expect(only("t")).toMatchObject({ sandboxRoot: root });
	});
	it("single-wolf root (den/, no dens/): den is <root>/den, no --wolf, and dens/ is never created", () => {
		const root = path.join(tmp, "single");
		wolf("t", `name: t\nextensions: [memory]\nsandbox:\n  root: ${root}\n`);
		sandboxRoot(root, "single");
		const plans = plan();
		expect(plans[0]).toMatchObject({ action: "install", shared: false, den: path.join(root, "den") });
		const calls: string[][] = [];
		runPlans(plans, { cli: "/cli.js", exec: (_f: string, a: string[]) => calls.push(a), log() {}, warn() {} });
		expect(calls).toEqual([["/cli.js", "sandbox", "install-extensions", root, "--extensions", "memory"]]);
		expect(fs.existsSync(path.join(root, "dens"))).toBe(false);
	});
	it("shared dens/: exact argv carries --wolf; a fresh bundle is skipped", () => {
		const root = path.join(tmp, "shared");
		wolf("a", `name: a\nextensions: [memory]\nsandbox:\n  root: ${root}\n`);
		wolf("b", `name: b\nextensions: [memory]\nsandbox:\n  root: ${root}\n`);
		sandboxRoot(root, "shared");
		bundle(path.join(root, "dens/b"), 2_000_000);
		bundle(path.join(root, "dens/a"), 500_000);
		const calls: string[][] = [];
		const logs: string[] = [];
		runPlans(plan(), { cli: "/cli.js", exec: (_f: string, a: string[]) => calls.push(a), log: (l: string) => logs.push(l), warn() {} });
		expect(calls).toEqual([["/cli.js", "sandbox", "install-extensions", root, "--wolf", "a", "--extensions", "memory"]]);
		expect(logs).toEqual(["dev-stack: extensions a: installed (memory; was stale)", "dev-stack: extensions b: up to date"]);
	});
	it("rejects an odd wolf name (no path escape), and one failure does not skip the rest", () => {
		const root = path.join(tmp, "shared");
		sandboxRoot(root, "shared");
		wolf("bad", `name: "../evil"\nextensions: [memory]\nsandbox:\n  root: ${root}\n`);
		wolf("good", `name: good\nextensions: [memory]\nsandbox:\n  root: ${root}\n`);
		const plans = plan();
		expect(plans.find((p: { action: string }) => p.action === "error")).toBeTruthy();
		expect(plans.filter((p: { action: string }) => p.action === "install").map((p: { wolf: string }) => p.wolf)).toEqual(["good"]);
		const calls: string[][] = [];
		const warns: string[] = [];
		runPlans(plans, {
			cli: "/c",
			exec: (_f: string, a: string[]) => {
				calls.push(a);
				if (a.includes("good")) throw new Error("boom");
			},
			log() {},
			warn: (w: string) => warns.push(w),
		});
		expect(warns.some((w) => w.includes("skipped"))).toBe(true);
		expect(warns.some((w) => w.includes("good") && w.includes("install failed"))).toBe(true);
	});
	it("guards: no snapshot.json, or a den symlinked outside the root, is an error", () => {
		const root = path.join(tmp, "nosnap");
		fs.mkdirSync(path.join(root, "dens"), { recursive: true });
		wolf("n", `name: n\nextensions: [memory]\nsandbox:\n  root: ${root}\n`);
		expect(only("n")).toMatchObject({ action: "error" });
		const root2 = path.join(tmp, "esc");
		sandboxRoot(root2, "shared");
		const outside = path.join(tmp, "outside");
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(root2, "dens", "e"));
		wolf("e", `name: e\nextensions: [memory]\nsandbox:\n  root: ${root2}\n`);
		expect(only("e")).toMatchObject({ action: "error" });
	});
	it("non-sandbox stale wolf only warns; unknown extension keys warn", () => {
		wolf("plain", "name: plain\nextensions: [memory, nope]\n");
		bundle(path.join(wolvesDir(), "plain"), 500_000);
		const warns: string[] = [];
		const calls: unknown[] = [];
		runPlans(plan(), { cli: "/c", exec: () => calls.push(1), log() {}, warn: (w: string) => warns.push(w) });
		expect(calls).toEqual([]);
		expect(warns.join("\n")).toMatch(/plain: unknown extension key\(s\) nope/);
		expect(warns.join("\n")).toMatch(/plain: installed extensions are stale/);
	});
	it("normalizes the wolfpack-memory alias", () => {
		wolf("alias", "name: alias\nextensions: [wolfpack-memory]\n");
		bundle(path.join(wolvesDir(), "alias"), 2_000_000);
		expect(only("alias")).toMatchObject({ action: "ok" });
	});
});

describe("main", () => {
	it("DEV_STACK_NO_EXT_INSTALL=1 does nothing; no args is an error (no ~/wolves default); logs the resolved dir", async () => {
		const logs: string[] = [];
		let ran = 0;
		await main({ argv: [wolvesDir()], env: { DEV_STACK_NO_EXT_INSTALL: "1" }, log: (l: string) => logs.push(l), exec: () => ran++ });
		expect(logs).toEqual(["dev-stack: extension install skipped (DEV_STACK_NO_EXT_INSTALL=1)"]);
		await expect(main({ argv: [], env: {}, exec: () => ran++ })).rejects.toThrow(/no default/);
		expect(ran).toBe(0);
		const logs2: string[] = [];
		await main({ argv: [wolvesDir()], env: {}, repo: REPO_REAL, log: (l: string) => logs2.push(l), exec: () => ran++ });
		expect(logs2[0]).toBe(`dev-stack: checking extension bundles for wolves in ${wolvesDir()}`);
		expect(ran).toBe(0); // empty wolves dir: nothing to do
	});
});
