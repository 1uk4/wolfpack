import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { runPreview } from "./runtime-preview.mjs";

let tmp: string, home: string, main: string, rtWt: string, origin: string, featSha: string;
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const commit = (cwd: string, file: string, body: string) => {
	fs.writeFileSync(path.join(cwd, file), body);
	g(cwd, "add", file);
	g(cwd, "commit", "-q", "-m", `edit ${file}`);
};
const stateFile = () => path.join(home, ".wolfpack", "preview", "state.json");
const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rtprev-")));
	home = path.join(tmp, "home");
	fs.mkdirSync(home);
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
const harness = (opts: { buildFails?: boolean; checkoutFails?: boolean } = {}) => {
	const calls: string[] = [];
	const gitCalls: string[][] = [];
	const logs: string[] = [];
	const steps = {
		git: (cwd: string, ...args: string[]) => {
			gitCalls.push(args);
			if (opts.checkoutFails && args[0] === "checkout" && args[1] === "--detach") throw new Error("checkout refused");
			if (args[0] === "checkout") calls.push(`git ${args.join(" ")}`);
			return g(cwd, ...args);
		},
		build: (wt: string) => {
			calls.push(`build@${g(wt, "rev-parse", "HEAD")}`);
			if (opts.buildFails && g(wt, "rev-parse", "HEAD") === featSha) throw new Error("boom");
		},
		spawnHelper: (a: { args: string[] }) => calls.push(`helper ${a.args.slice(4).join(" ")}`),
	};
	const run = (argv: string[]) =>
		runPreview({ argv, env: { HOME: home, WOLVES_DIR: path.join(tmp, "wolves") }, cwd: rtWt, steps, log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) });
	return { calls, gitCalls, logs, run };
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

	it("on: refuses a dirty runtime and an active preview of another ref, changing nothing", async () => {
		const h = harness();
		fs.writeFileSync(path.join(rtWt, "a.txt"), "dirty");
		expect((await h.run(["feat/x"])).exitCode).toBe(1);
		expect(fs.existsSync(stateFile())).toBe(false);
		g(rtWt, "checkout", "-q", "--", "a.txt");

		await h.run(["feat/x"]);
		h.calls.length = 0;
		const before = fs.readFileSync(stateFile(), "utf8");
		expect((await h.run(["main"])).exitCode).toBe(1);
		expect(h.calls).toEqual([]);
		expect(fs.readFileSync(stateFile(), "utf8")).toBe(before);
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

	it("status with no state says stable, no preview", async () => {
		const h = harness();
		await h.run(["status"]);
		expect(h.logs.join("\n")).toContain("stable, no preview");
	});
});
