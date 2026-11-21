// Guards ci.yml's package-manager wiring: pnpm everywhere it installs or runs workspace scripts, store cached, no turbo remote cache.
// release.yml is deliberately not checked here (releases build with npm; pnpm is for development and CI only).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { id?: string; if?: string; name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { steps?: Step[]; if?: string; needs?: string | string[]; concurrency?: { group?: string; "cancel-in-progress"?: boolean } };
const raw = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const ci = parse(raw) as { jobs: Record<string, Job>; env?: Record<string, string> };
const pm = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).packageManager as string;
// The shared setup lives in a composite action; jobs call it with `uses: ./.github/actions/setup`. Every invariant below looks THROUGH it:
// a job's effective steps are its own steps with the action's steps spliced in where it is used.
const ACTION = "./.github/actions/setup";
const actionUrl = new URL("../.github/actions/setup/action.yml", import.meta.url);
const action = (existsSync(actionUrl) ? parse(readFileSync(actionUrl, "utf8")) : { runs: { steps: [] } }) as { runs: { using?: string; steps: Step[] } };
const effective = (j: Job): Step[] => (j.steps ?? []).flatMap((s) => (s.uses === ACTION ? action.runs.steps : [s]));
const runs = Object.entries(ci.jobs).flatMap(([job, j]) => effective(j).filter((s) => s.run).map((s) => ({ job, step: s.name ?? s.run!.split("\n")[0], run: s.run! })));
const installers = Object.entries(ci.jobs).filter(([, j]) => effective(j).some((s) => s.run && /\bpnpm install\b/.test(s.run))).map(([n]) => n);
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
			const steps = effective(ci.jobs[name]);
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
		const steps = effective(ci.jobs.checks);
		const install = steps.findIndex((s) => s.run && /pnpm install --frozen-lockfile/.test(s.run));
		const guard = steps.findIndex((s) => s.run && /pnpm check:lockfiles/.test(s.run));
		expect(install).toBeGreaterThanOrEqual(0);
		expect(guard).toBe(install + 1);
		expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts["check:lockfiles"]).toBe("node scripts/check-lockfiles.mjs .");
	});

	it("the checks job lints the console and the final fail step accounts for it", () => {
		const steps = effective(ci.jobs.checks);
		const lint = steps.find((s) => s.run && /pnpm --filter @wolfpack\/console lint\b/.test(s.run)) as (Step & { "continue-on-error"?: boolean }) | undefined;
		expect(lint, "console lint step").toBeDefined();
		expect(lint!["continue-on-error"]).toBe(true);
		const fail = steps.find((s) => s.name === "fail if any check failed")!;
		expect(fail.env?.LINT).toBe(`\${{ steps.${lint!.id}.outcome }}`);
		expect(fail.run).toMatch(/\$LINT" != success/);
	});

	it("every installing job gets its setup from the one composite action (jobs enumerated from the YAML)", () => {
		expect(installers).toEqual(expect.arrayContaining(["checks", "vitest", "console-tests", "eval"]));
		const bad = installers.filter((n) => !(ci.jobs[n].steps ?? []).some((s) => s.uses === ACTION));
		expect(bad).toEqual([]);
		// ...and none of them repeats the pieces inline
		const inline = Object.entries(ci.jobs).filter(([, j]) => (j.steps ?? []).some((s) => /^(pnpm\/action-setup|actions\/cache)@/.test(s.uses ?? "") || (s.run && /pnpm install\b/.test(s.run)))).map(([n]) => n);
		expect(inline).toEqual([]);
		expect(action.runs.using).toBe("composite");
	});

	it("the node_modules cache has no restore-keys fallback and its key hashes the lockfile", () => {
		const nm = action.runs.steps.find((s) => s.uses?.startsWith("actions/cache@") && /node_modules/.test(String(s.with?.path)));
		expect(nm, "node_modules cache step").toBeDefined();
		expect(nm!.with).not.toHaveProperty("restore-keys");
		expect(String(nm!.with!.key)).toMatch(/hashFiles\([^)]*'pnpm-lock\.yaml'/);
		expect(String(nm!.with!.key)).toContain("runner.os");
		// install is skipped only on an exact node_modules hit
		const install = action.runs.steps.find((s) => s.run && /pnpm install --frozen-lockfile/.test(s.run))!;
		expect(install.if).toBe(`steps.${nm!.id}.outputs.cache-hit != 'true'`);
	});

	it("tsc --build runs unconditionally after the tsc cache is restored (never gated on a cache hit)", () => {
		const cacheStep = action.runs.steps.find((s) => s.uses?.startsWith("actions/cache@") && /dist/.test(String(s.with?.path)));
		expect(cacheStep, "tsc output cache step").toBeDefined();
		const tscJobs = Object.entries(ci.jobs).filter(([, j]) => (j.steps ?? []).some((s) => s.run && /exec tsc --build/.test(s.run)));
		expect(tscJobs.map(([n]) => n).sort()).toEqual(["checks", "console-tests", "eval", "vitest"]);
		for (const [name, j] of tscJobs) {
			const steps = effective(j);
			const cacheAt = steps.indexOf(cacheStep!);
			for (const [i, s] of steps.entries()) {
				if (!s.run || !/exec tsc --build/.test(s.run)) continue;
				expect(i, name).toBeGreaterThan(cacheAt);
				expect(s.if, name).toBeUndefined();
			}
		}
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
		const steps = effective(job);
		const install = steps.findIndex((s) => s.run && /pnpm install --frozen-lockfile/.test(s.run));
		const evalRun = steps.findIndex((s) => s.run && /^pnpm test:eval$/m.test(s.run));
		expect(install).toBeGreaterThanOrEqual(0);
		expect(evalRun).toBeGreaterThan(install);
		expect(ci.jobs.ci.needs).toContain("eval");
	});

	it("eval builds before it runs the evals (the evals import @wolfpack/engine from dist)", () => {
		const steps = effective(ci.jobs.eval);
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
