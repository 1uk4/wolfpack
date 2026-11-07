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
// comment lines may mention npm; only real commands count
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("ci.yml uses pnpm", () => {
	it("no run step calls npm or npx", () => {
		const bad = runs.filter((r) => /(^|[\s;&|(])(npm|npx)\s/.test(code(r.run))).map((r) => `${r.job}: ${r.step}`);
		expect(bad).toEqual([]);
	});

	it("every vitest invocation in the verify job selects the default project (no evals or live tests in CI verify)", () => {
		const lines = runs.filter((r) => r.job === "verify").flatMap((r) => code(r.run).split("\n")).filter((l) => /\bvitest run\b/.test(l));
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines.filter((l) => !/--project default\b/.test(l))).toEqual([]);
	});

	it("the verify job installs with a frozen pnpm lockfile", () => {
		expect(runs.some((r) => r.job === "verify" && /pnpm install --frozen-lockfile/.test(r.run))).toBe(true);
	});

	it("the console tests run through pnpm --filter", () => {
		const r = runs.find((x) => x.step === "console tests");
		expect(r?.run).toMatch(/pnpm --filter @wolfpack\/console (run )?test/);
	});

	it("pnpm is set up before setup-node, from the packageManager field, and the store is cached", () => {
		const steps = ci.jobs.verify.steps!;
		const setup = steps.findIndex((s) => s.uses?.startsWith("pnpm/action-setup@"));
		const node = steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@"));
		expect(setup).toBeGreaterThanOrEqual(0);
		expect(setup).toBeLessThan(node);
		expect(steps[setup].with?.version).toBeUndefined(); // reads packageManager (= ${pm})
		expect(steps[node].with?.cache).toBe("pnpm");
		expect(pm).toMatch(/^pnpm@/);
	});

	it("the verify job runs the lockfile guard right after the install", () => {
		const steps = ci.jobs.verify.steps!;
		const install = steps.findIndex((s) => s.run && /pnpm install --frozen-lockfile/.test(s.run));
		const guard = steps.findIndex((s) => s.run && /pnpm check:lockfiles/.test(s.run));
		expect(guard).toBeGreaterThan(install);
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
		expect(job.if).toBe("needs.detect.outputs.release == 'true'");
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
