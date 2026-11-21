// Guards ci.yml's package-manager wiring: pnpm everywhere it installs or runs workspace scripts, store cached, no turbo remote cache.
// release.yml is deliberately not checked here (releases build with npm; pnpm is for development and CI only).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { id?: string; name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { steps?: Step[]; if?: string; needs?: string | string[]; concurrency?: { group?: string; "cancel-in-progress"?: boolean } };
const raw = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const ci = parse(raw) as { jobs: Record<string, Job>; env?: Record<string, string> };
const pm = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).packageManager as string;
const runs = Object.entries(ci.jobs).flatMap(([job, j]) => (j.steps ?? []).filter((s) => s.run).map((s) => ({ job, step: s.name ?? s.run!.split("\n")[0], run: s.run! })));
const installers = Object.entries(ci.jobs).filter(([, j]) => (j.steps ?? []).some((s) => s.run && /\bpnpm install\b/.test(s.run))).map(([n]) => n);
// comment lines may mention npm; only real commands count
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("ci.yml uses pnpm", () => {
	it("no run step calls npm or npx", () => {
		const bad = runs.filter((r) => /(^|[\s;&|(])(npm|npx)\s/.test(code(r.run))).map((r) => `${r.job}: ${r.step}`);
		expect(bad).toEqual([]);
	});

	it("every vitest invocation in the vitest job selects the default project and a shard (no evals or live tests, no file run twice)", () => {
		const lines = runs.filter((r) => r.job === "vitest").flatMap((r) => code(r.run).split("\n")).filter((l) => /\bvitest run\b/.test(l));
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines.filter((l) => !/--project default\b/.test(l))).toEqual([]);
		expect(lines.filter((l) => !/--shard "\$SHARD"/.test(l))).toEqual([]);
	});

	it("every job that installs uses a frozen pnpm lockfile", () => {
		const bad = runs.filter((r) => /\bpnpm install\b/.test(code(r.run)) && !/pnpm install --frozen-lockfile/.test(r.run)).map((r) => r.job);
		expect(bad).toEqual([]);
		expect(installers).toEqual(expect.arrayContaining(["checks", "vitest", "console-tests", "eval"]));
	});

	it("the console tests run through pnpm --filter", () => {
		const r = runs.find((x) => x.step === "console tests");
		expect(r?.job).toBe("console-tests");
		expect(r?.run).toMatch(/pnpm --filter @wolfpack\/console (run )?test/);
	});

	it("in every installing job pnpm is set up before setup-node, from the packageManager field, and the store is cached", () => {
		for (const name of installers) {
			const steps = ci.jobs[name].steps!;
			const setup = steps.findIndex((s) => s.uses?.startsWith("pnpm/action-setup@"));
			const node = steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@"));
			expect(setup, name).toBeGreaterThanOrEqual(0);
			expect(setup, name).toBeLessThan(node);
			expect(steps[setup].with?.version, name).toBeUndefined(); // reads packageManager (= ${pm})
			expect(steps[node].with?.cache, name).toBe("pnpm");
		}
		expect(pm).toMatch(/^pnpm@/);
	});

	it("the vitest matrix is exactly shards 1/3, 2/3 and 3/3 and does not fail fast", () => {
		const strategy = (ci.jobs.vitest as Job & { strategy?: { "fail-fast"?: boolean; matrix?: { shard?: string[] } } }).strategy;
		expect(strategy?.matrix?.shard).toEqual(["1/3", "2/3", "3/3"]);
		expect(strategy?.["fail-fast"]).toBe(false);
	});

	it("the ci aggregate needs every other job, so a new test or check job cannot go unrequired", () => {
		const needs = [ci.jobs.ci.needs].flat() as string[];
		expect([...needs].sort()).toEqual(Object.keys(ci.jobs).filter((n) => n !== "ci").sort());
	});

	it("no job raised timeout-minutes above 30 (release-smoke keeps its 40)", () => {
		const over = Object.entries(ci.jobs).filter(([n, j]) => ((j as { "timeout-minutes"?: number })["timeout-minutes"] ?? 0) > (n === "release-smoke" ? 40 : 30)).map(([n]) => n);
		expect(over).toEqual([]);
	});

	it("the checks job runs the lockfile guard right after the install", () => {
		const steps = ci.jobs.checks.steps!;
		const install = steps.findIndex((s) => s.run && /pnpm install --frozen-lockfile/.test(s.run));
		const guard = steps.findIndex((s) => s.run && /pnpm check:lockfiles/.test(s.run));
		expect(install).toBeGreaterThanOrEqual(0);
		expect(guard).toBe(install + 1);
		expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts["check:lockfiles"]).toBe("node scripts/check-lockfiles.mjs .");
	});

	it("no turbo remote cache in CI", () => {
		expect(raw).not.toMatch(/TURBO_(TOKEN|TEAM|REMOTE)|--remote-cache|remote-cache/i);
	});
});

describe("ci.yml release runs (PR into stable, push to stable)", () => {
	const detect = ci.jobs.detect as Job & { outputs?: Record<string, string> };
	const affectedStep = detect.steps!.find((s) => s.name === "affected packages")!;
	const releaseStep = detect.steps!.find((s) => s.id === "release")!;

	it("detect computes a release flag from the stable base branch or the stable ref", () => {
		expect(detect.outputs?.release).toContain("steps.release.outputs.release");
		const env = JSON.stringify(releaseStep.env);
		expect(env).toContain("github.base_ref == 'stable'");
		expect(env).toContain("github.ref == 'refs/heads/stable'");
	});

	it("on a release the affected computation is forced to everything (empty base)", () => {
		expect(detect.steps!.indexOf(releaseStep)).toBeLessThan(detect.steps!.indexOf(affectedStep));
		expect(affectedStep.env?.RELEASE).toContain("steps.release.outputs.release");
		expect(affectedStep.run).toMatch(/RELEASE.*=.*true[\s\S]*BASE=""/);
	});

	it("tracer and release-smoke run unconditionally on a release", () => {
		for (const name of ["tracer", "release-smoke"]) {
			expect(ci.jobs[name].if).toContain("needs.detect.outputs.release == 'true'");
			expect(ci.jobs[name].if).toContain("fromJSON(needs.detect.outputs.affected)");
		}
	});

	it("the eval job runs pnpm test:eval after a frozen install, only on a release, and the ci aggregate waits for it", () => {
		const job = ci.jobs.eval;
		expect(job.if).toBe("needs.detect.outputs.release == 'true' && needs.detect.outputs.coveredByPr != 'true'");
		const steps = job.steps!;
		const install = steps.findIndex((s) => s.run && /pnpm install --frozen-lockfile/.test(s.run));
		const evalRun = steps.findIndex((s) => s.run && /^pnpm test:eval$/m.test(s.run));
		expect(install).toBeGreaterThanOrEqual(0);
		expect(evalRun).toBeGreaterThan(install);
		expect(ci.jobs.ci.needs).toContain("eval");
	});

	it("eval builds before it runs the evals (the evals import @wolfpack/engine from dist)", () => {
		const steps = ci.jobs.eval.steps!;
		const install = steps.findIndex((s) => s.run && /pnpm install --frozen-lockfile/.test(s.run));
		const build = steps.findIndex((s) => s.run && /tsc --build packages\/kb\b/.test(s.run));
		const evalRun = steps.findIndex((s) => s.run && /^pnpm test:eval$/m.test(s.run));
		expect(build).toBeGreaterThan(install);
		expect(build).toBeLessThan(evalRun);
	});

	it("eval runs are never cancelled by a newer push (own concurrency group)", () => {
		expect(ci.jobs.eval.concurrency?.["cancel-in-progress"]).toBe(false);
		expect(ci.jobs.eval.concurrency?.group).toContain("eval");
	});

	it("no secrets and no live tests in CI (live runs in wolfpack pr prepare)", () => {
		expect(code(raw)).not.toMatch(/secrets\.|test:live|pull_request_target/);
	});
});

describe("one CI run per commit (a push covered by an open PR skips; the pull_request run does the work)", () => {
	const detectJob = ci.jobs.detect as Job & { outputs?: Record<string, string> };
	const guarded = Object.entries(ci.jobs).filter(([n, j]) => n !== "ci" && n !== "detect" && [j.needs].flat().includes("detect"));

	it("detect exposes coveredByPr and computes it only on push events, matching the PR head sha", () => {
		expect(detectJob.outputs?.coveredByPr).toMatch(/steps\.\w+\.outputs\.coveredByPr/);
		const step = (detectJob.steps ?? []).find((s) => s.run && /coveredByPr=/.test(s.run));
		expect(step?.run).toMatch(/commits\/\$SHA\/pulls/);
		expect(step?.run).toMatch(/head\.sha == \$sha|head\.sha==\$sha/);
		expect(step?.run).toMatch(/\.state == "open"|state=="open"/);
		expect((step as { if?: string }).if).toBe("github.event_name == 'push'");
	});

	it("every job that needs detect skips when the push is covered by a PR (jobs enumerated from the YAML)", () => {
		expect(guarded.length).toBeGreaterThanOrEqual(6);
		const bad = guarded.filter(([, j]) => !/needs\.detect\.outputs\.coveredByPr != 'true'/.test(j.if ?? "")).map(([n]) => n);
		expect(bad).toEqual([]);
	});

	it("the ci aggregate passes with a covered-by-PR message and otherwise keeps the all-jobs check", () => {
		const steps = ci.jobs.ci.steps!;
		const covered = steps.find((s) => s.run && /covered by PR #/.test(s.run)) as (Step & { if?: string }) | undefined;
		expect(covered?.if).toMatch(/needs\.detect\.outputs\.coveredByPr == 'true'/);
		const all = steps.find((s) => s.run && /failure\|cancelled/.test(s.run)) as (Step & { if?: string }) | undefined;
		expect(all?.if).toMatch(/needs\.detect\.outputs\.coveredByPr != 'true'/);
	});
});
