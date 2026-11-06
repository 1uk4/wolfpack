// Guards ci.yml's package-manager wiring: pnpm everywhere it installs or runs workspace scripts, store cached, no turbo remote cache.
// release.yml is deliberately not checked here (it stays on npm until the release images move).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { steps?: Step[] };
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
