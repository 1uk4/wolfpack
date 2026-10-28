import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs script
import { classify, runUpdate } from "./runtime-update.mjs";

let tmp: string;
let main: string, intWt: string, rtWt: string, featWt: string, origin: string;
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const commit = (cwd: string, file: string, body: string, msg = `edit ${file}`) => {
	fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
	fs.writeFileSync(path.join(cwd, file), body);
	g(cwd, "add", file);
	g(cwd, "commit", "-q", "-m", msg);
};

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rtupd-")));
	origin = path.join(tmp, "origin.git");
	g(tmp, "init", "-q", "--bare", "-b", "main", origin);
	main = path.join(tmp, "main");
	g(tmp, "init", "-q", "-b", "main", main);
	g(main, "config", "user.email", "t@t");
	g(main, "config", "user.name", "t");
	g(main, "remote", "add", "origin", origin);
	commit(main, "README.md", "hi");
	commit(main, "shared.txt", "base\n");
	g(main, "branch", "wolf/1uk4");
	g(main, "branch", "stable");
	g(main, "branch", "feat/x");
	intWt = path.join(tmp, "int");
	rtWt = path.join(tmp, "rt");
	featWt = path.join(tmp, "feat");
	g(main, "worktree", "add", "-q", intWt, "wolf/1uk4");
	g(main, "worktree", "add", "-q", rtWt, "stable");
	g(main, "worktree", "add", "-q", featWt, "feat/x");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const steps = () => ({ build: vi.fn(), refreshExtensions: vi.fn(async () => []) });
const run = (argv: string[], s = steps()) => {
	const logs: string[] = [];
	const warns: string[] = [];
	return runUpdate({ argv, env: { WOLVES_DIR: path.join(tmp, "wolves") }, cwd: intWt, steps: s, log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) }).then((r: any) => ({ r, logs, warns, s }));
};

describe("runtime-update", () => {
	it("fast-forwards integration and runtime, builds, pushes", async () => {
		commit(featWt, "apps/console/a.tsx", "x");
		const { r, s } = await run(["feat/x"]);
		expect(r.exitCode).toBe(0);
		expect(g(intWt, "rev-parse", "HEAD")).toBe(g(featWt, "rev-parse", "HEAD"));
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(g(featWt, "rev-parse", "HEAD"));
		expect(s.build).toHaveBeenCalledWith(rtWt);
		expect(r.classification.action).toBe("reload");
		expect(r.pushed).toBe(true);
		expect(g(origin, "rev-parse", "stable")).toBe(g(rtWt, "rev-parse", "HEAD"));
	});

	it("makes a merge commit when integration has moved", async () => {
		commit(featWt, "packages/kb/src/a.ts", "x");
		commit(intWt, "other.txt", "y");
		const { r } = await run(["feat/x"]);
		expect(r.exitCode).toBe(0);
		expect(g(intWt, "log", "-1", "--format=%s")).toBe("Merge branch 'feat/x' into wolf/1uk4");
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(g(intWt, "rev-parse", "HEAD"));
		expect(r.classification.action).toBe("restart");
	});

	it("aborts a conflicting merge and leaves the integration tree clean", async () => {
		commit(featWt, "shared.txt", "feat\n");
		commit(intWt, "shared.txt", "int\n");
		const before = g(intWt, "rev-parse", "HEAD");
		const { r, warns, s } = await run(["feat/x"]);
		expect(r.exitCode).toBe(1);
		expect(r.conflicts).toEqual(["shared.txt"]);
		expect(warns.join("\n")).toContain("shared.txt");
		expect(g(intWt, "status", "--porcelain")).toBe("");
		expect(g(intWt, "rev-parse", "HEAD")).toBe(before);
		expect(s.build).not.toHaveBeenCalled();
	});

	it("refuses when stable has diverged", async () => {
		commit(rtWt, "stable-only.txt", "s");
		const stableBefore = g(rtWt, "rev-parse", "HEAD");
		commit(intWt, "int.txt", "i");
		const { r, warns, s } = await run([]);
		expect(r.exitCode).toBe(1);
		expect(warns.join("\n")).toContain("diverged");
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(stableBefore);
		expect(s.build).not.toHaveBeenCalled();
	});

	it("refuses dirty integration and runtime trees", async () => {
		commit(featWt, "a.txt", "a");
		fs.writeFileSync(path.join(intWt, "README.md"), "dirty");
		let o = await run(["feat/x"]);
		expect(o.r.exitCode).toBe(1);
		expect(o.warns.join()).toContain("integration worktree");
		g(intWt, "checkout", "--", "README.md");
		fs.writeFileSync(path.join(rtWt, "README.md"), "dirty");
		o = await run(["feat/x"]);
		expect(o.r.exitCode).toBe(1);
		expect(o.warns.join()).toContain("runtime worktree");
		expect(g(intWt, "rev-parse", "HEAD")).not.toBe(g(featWt, "rev-parse", "HEAD"));
	});

	it("fails clearly when a branch is not checked out", async () => {
		const logs: string[] = [];
		const r = await runUpdate({ argv: [], env: { RUNTIME_BRANCH: "nope" }, cwd: intWt, steps: steps(), log: () => {}, warn: (m: string) => logs.push(m) });
		expect(r.exitCode).toBe(1);
		expect(logs[0]).toContain("nope is not checked out");
	});

	it("dry-run changes no refs and runs no steps", async () => {
		commit(featWt, "packages/agent/src/a.ts", "x");
		const refs = () => g(main, "for-each-ref", "--format=%(refname) %(objectname)");
		const before = refs();
		const { r, logs, s } = await run(["feat/x", "--dry-run"]);
		expect(r.exitCode).toBe(0);
		expect(refs()).toBe(before);
		expect(s.build).not.toHaveBeenCalled();
		expect(logs.join("\n")).toContain("sfo-01 runs packages/agent");
		expect(g(origin, "for-each-ref")).toBe("");
	});

	it("still succeeds when the push fails", async () => {
		commit(featWt, "docs/a.md", "x");
		g(main, "remote", "set-url", "origin", path.join(tmp, "missing.git"));
		const { r, warns } = await run(["feat/x"]);
		expect(r.exitCode).toBe(0);
		expect(r.pushed).toBe(false);
		expect(warns.join()).toContain("push failed");
	});

	it("reports already up to date", async () => {
		const { r, logs } = await run([]);
		expect(r.classification.lines).toEqual(["already up to date"]);
		expect(logs.join()).toContain("already up to date");
	});
});

describe("classify", () => {
	it("console only / docs / tests", () => {
		expect(classify(["apps/console/src/a.tsx", "docs/x.md", "packages/kb/src/a.test.ts"]).lines).toEqual(["console only: reload the window (Cmd-R)"]);
		expect(classify(["docs/x.md"]).action).toBe("none");
	});
	it("restart for runtime packages, extensions, refreshed bundles", () => {
		for (const f of ["packages/harness/src/a.ts", "packages/workerd/src/a.ts", "packages/protocol/src/a.ts", "packages/client/src/a.ts", "packages/engine/src/a.ts", "packages/memory/src/a.ts", "packages/kb/src/a.ts", "extensions/wolfpack-memory/index.ts"])
			expect(classify(["apps/console/a.tsx", f]).lines[0]).toContain("restart the stack");
		expect(classify([], ["1uk4"]).action).toBe("restart");
	});
	it("agent adds the redeploy note", () => {
		expect(classify(["packages/agent/src/a.ts"]).lines).toEqual(["restart the stack: Ctrl-C, then npm run dev:stack:desktop", "sfo-01 runs packages/agent: redeploy needed"]);
	});
});
