import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs script
import { classify, runUpdate } from "./runtime-update.mjs";

let tmp: string;
let main: string, intWt: string, rtWt: string, origin: string;
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
	g(main, "push", "-q", "origin", "stable");
	intWt = path.join(tmp, "int");
	rtWt = path.join(tmp, "rt");
	g(main, "worktree", "add", "-q", intWt, "wolf/1uk4");
	g(main, "worktree", "add", "-q", rtWt, "stable");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The owner merges a release on GitHub: stable on origin moves. Done from a separate clone, like the owner's merge would. */
const ownerMerges = (file: string, body = "x") => {
	const clone = path.join(tmp, "owner");
	if (!fs.existsSync(clone)) {
		g(tmp, "clone", "-q", "-b", "stable", origin, clone);
		g(clone, "config", "user.email", "o@o");
		g(clone, "config", "user.name", "o");
	}
	commit(clone, file, body);
	g(clone, "push", "-q", "origin", "stable");
	return g(clone, "rev-parse", "HEAD");
};

const steps = () => ({ build: vi.fn(), refreshExtensions: vi.fn(async () => []) });
const run = (argv: string[], s = steps()) => {
	const logs: string[] = [];
	const warns: string[] = [];
	return runUpdate({ argv, env: { WOLVES_DIR: path.join(tmp, "wolves") }, cwd: intWt, steps: s, log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) }).then((r: any) => ({ r, logs, warns, s }));
};

describe("runtime-update", () => {
	it("fetches, fast-forwards the stable worktree to origin/stable and builds; it never pushes and never touches wolf/1uk4", async () => {
		const owner = ownerMerges("apps/console/a.tsx");
		const intBefore = g(intWt, "rev-parse", "HEAD");
		const { r, s } = await run([]);
		expect(r.exitCode).toBe(0);
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(owner);
		expect(s.build).toHaveBeenCalledWith(rtWt);
		expect(r.classification.action).toBe("reload");
		expect(r).not.toHaveProperty("pushed");
		expect(g(intWt, "rev-parse", "HEAD")).toBe(intBefore);
		expect(g(origin, "rev-parse", "stable")).toBe(owner);
		expect(g(origin, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/stable");
	});

	it("refuses a branch argument, pointing at wolfpack pr prepare, and changes nothing", async () => {
		const stableBefore = g(rtWt, "rev-parse", "HEAD");
		ownerMerges("a.txt");
		const { r, warns, s } = await run(["feat/x"]);
		expect(r.exitCode).toBe(1);
		expect(warns.join("\n")).toContain("wolfpack pr prepare");
		expect(warns.join("\n")).toContain("feat/x");
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(stableBefore);
		expect(s.build).not.toHaveBeenCalled();
		expect(s.refreshExtensions).not.toHaveBeenCalled();
	});

	it("refuses when stable has diverged from origin/stable, and changes nothing there", async () => {
		commit(rtWt, "stable-only.txt", "s");
		const stableBefore = g(rtWt, "rev-parse", "HEAD");
		ownerMerges("owner.txt");
		const { r, warns, s } = await run([]);
		expect(r.exitCode).toBe(1);
		expect(warns.join("\n")).toContain("diverged");
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(stableBefore);
		expect(s.build).not.toHaveBeenCalled();
	});

	it("says 'ahead' not 'diverged', and changes nothing, when stable is merely ahead of origin/stable", async () => {
		commit(rtWt, "local-only.txt", "s");
		const before = g(rtWt, "rev-parse", "HEAD");
		const { r, warns, s } = await run([]);
		expect(r.exitCode).toBe(1);
		expect(warns.join("\n")).toContain("ahead of origin/stable");
		expect(warns.join("\n")).not.toContain("diverged");
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(before);
		expect(s.build).not.toHaveBeenCalled();
	});

	it("refuses a dirty runtime worktree", async () => {
		ownerMerges("a.txt");
		fs.writeFileSync(path.join(rtWt, "README.md"), "dirty");
		const o = await run([]);
		expect(o.r.exitCode).toBe(1);
		expect(o.warns.join()).toContain("runtime worktree");
		expect(o.s.build).not.toHaveBeenCalled();
	});

	it("ignores generated files when checking for a dirty tree", async () => {
		const owner = ownerMerges("apps/console/next-env.d.ts", "a");
		g(main, "fetch", "-q", "origin");
		g(rtWt, "merge", "-q", "--ff-only", "origin/stable");
		fs.writeFileSync(path.join(rtWt, "apps/console/next-env.d.ts"), "regenerated");
		const { r } = await run([]);
		expect(r.exitCode).toBe(0);
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(owner);
		fs.writeFileSync(path.join(rtWt, "README.md"), "dirty");
		expect((await run([])).r.exitCode).toBe(1);
	});

	it("fails clearly when a branch is not checked out", async () => {
		const logs: string[] = [];
		const r = await runUpdate({ argv: [], env: { RUNTIME_BRANCH: "nope" }, cwd: intWt, steps: steps(), log: () => {}, warn: (m: string) => logs.push(m) });
		expect(r.exitCode).toBe(1);
		expect(logs[0]).toContain("nope is not checked out");
	});

	it("fails clearly, changing nothing, when the fetch fails", async () => {
		const before = g(rtWt, "rev-parse", "HEAD");
		g(main, "remote", "set-url", "origin", path.join(tmp, "missing.git"));
		const { r, warns, s } = await run([]);
		expect(r.exitCode).toBe(1);
		expect(warns.join()).toContain("fetch failed");
		expect(g(rtWt, "rev-parse", "HEAD")).toBe(before);
		expect(s.build).not.toHaveBeenCalled();
	});

	it("dry-run does not fetch, changes no refs and runs no steps", async () => {
		ownerMerges("packages/agent/src/a.ts");
		g(main, "fetch", "-q", "origin", "+refs/heads/stable:refs/remotes/origin/stable");
		ownerMerges("later.txt");
		const refs = () => g(main, "for-each-ref", "--format=%(refname) %(objectname)");
		const before = refs();
		const { r, logs, s } = await run(["--dry-run"]);
		expect(r.exitCode).toBe(0);
		expect(refs()).toBe(before);
		expect(s.build).not.toHaveBeenCalled();
		expect(logs.join("\n")).toContain("would fast-forward stable to origin/stable");
		expect(logs.join("\n")).toContain("sfo-01 runs packages/agent");
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
		expect(classify(["packages/agent/src/a.ts"]).lines).toEqual(["restart the stack: npm run stack -- restart", "sfo-01 runs packages/agent: redeploy needed"]);
	});
});
