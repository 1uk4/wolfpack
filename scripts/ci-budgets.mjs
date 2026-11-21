#!/usr/bin/env node
// Measures per-job wall time of ci.yml runs and prints proposed timeout-minutes budgets. Needs only an authenticated `gh`.
// Usage: node scripts/ci-budgets.mjs [--since <ISO time>] [--limit 60] [--json]
// Budget = ceil(2 x p95 in minutes), floor 3. A job with fewer than 5 samples falls back to 2 x max.
// Only successful jobs of runs created after --since count (skipped jobs have no start/complete times and are ignored).
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
// default: the shape after the verify split and caches (c7a2b013, 2026-11-20 16:07 -08:00)
const since = Date.parse(opt("--since", "2026-11-20T16:07:00-08:00"));
const limit = opt("--limit", "60");
const gh = (a) => JSON.parse(execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

export const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
export const budget = (minutes) => {
	const s = [...minutes].sort((a, b) => a - b);
	const basis = s.length >= 5 ? percentile(s, 0.95) : s[s.length - 1];
	return Math.max(3, Math.ceil(2 * basis));
};

const runs = gh(["run", "list", "--workflow", "ci.yml", "--limit", limit, "--json", "databaseId,createdAt,event,conclusion"]).filter((r) => Date.parse(r.createdAt) > since);
const byJob = new Map();
for (const r of runs) {
	const { jobs } = gh(["run", "view", String(r.databaseId), "--json", "jobs"]);
	for (const j of jobs) {
		if (j.conclusion !== "success" || !j.startedAt || !j.completedAt) continue;
		const name = j.name.replace(/ \(.*\)$/, ""); // matrix legs "vitest (1/3)" pool into "vitest"
		const min = (Date.parse(j.completedAt) - Date.parse(j.startedAt)) / 60000;
		if (!(min > 0)) continue;
		(byJob.get(name) ?? byJob.set(name, []).get(name)).push(min);
	}
}
const rows = [...byJob].map(([job, m]) => {
	const s = [...m].sort((a, b) => a - b);
	return { job, n: s.length, p50: +percentile(s, 0.5).toFixed(1), p95: +percentile(s, 0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), budget: budget(s), basis: s.length >= 5 ? "p95" : "max" };
});
if (args.includes("--json")) console.log(JSON.stringify(Object.fromEntries(rows.map((r) => [r.job, r.budget])), null, 2));
else {
	console.log(`runs since ${new Date(since).toISOString()}: ${runs.length}`);
	console.log("job".padEnd(16) + "n".padStart(4) + "p50".padStart(8) + "p95".padStart(8) + "max".padStart(8) + "budget".padStart(8) + "  basis");
	for (const r of rows) console.log(r.job.padEnd(16) + String(r.n).padStart(4) + String(r.p50).padStart(8) + String(r.p95).padStart(8) + String(r.max).padStart(8) + String(r.budget).padStart(8) + "  " + r.basis + (r.n < 5 ? " (n<5)" : ""));
}
