#!/usr/bin/env node
// Measures per-job wall time of ci.yml runs and prints proposed timeout-minutes budgets. Needs only an authenticated `gh`.
// Usage: node scripts/ci-budgets.mjs [--since <ISO time | commit sha>] [--limit 60] [--json] [--help]
// Budget = ceil(2 x p95 in minutes), floor 3. A job with fewer than 5 samples falls back to 2 x max.
// Only successful jobs of runs created after --since count (skipped jobs have no start/complete times and are ignored).
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const HELP = `Usage: node scripts/ci-budgets.mjs [--since <ISO date | commit sha>] [--limit N] [--json] [--help]
  --since  only runs created after this time. A commit sha is resolved to its commit date. Default: 2026-11-20T16:07:00-08:00
           (the date of c7a2b013, the verify split with caches).
  --limit  how many recent ci.yml runs to list (default 60)
  --json   print {job: budget minutes} instead of the table
Budget = ceil(2 x p95), floor 3 minutes; fewer than 5 samples falls back to 2 x max. Needs only an authenticated gh.`;
if (args.includes("--help") || args.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}
const sinceArg = opt("--since", "2026-11-20T16:07:00-08:00");
let since = Date.parse(sinceArg);
if (Number.isNaN(since)) {
	try {
		since = Date.parse(execFileSync("git", ["log", "-1", "--format=%cI", sinceArg], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
	} catch {}
}
if (Number.isNaN(since)) {
	console.error(`--since: "${sinceArg}" is neither a date nor a commit in this repo\n${HELP}`);
	process.exit(2);
}
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
