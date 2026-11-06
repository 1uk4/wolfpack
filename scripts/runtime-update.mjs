#!/usr/bin/env node
/**
 * npm run runtime:update [--dry-run]
 *
 * origin/stable -> runtime (stable worktree) -> build -> refresh den extensions. Fetches, fast-forwards only (refuses if the
 * runtime cannot fast-forward), never merges a branch, never rebases, never pushes. Merging into stable is the owner's job on
 * GitHub (`wolfpack pr prepare` opens the PR). A branch argument is refused. All branches are worktrees of one repo; located
 * with `git worktree list`. Env: RUNTIME_BRANCH (stable), WOLVES_DIR (~/wolves/local).
 * Build and extension refresh are injectable (`steps`) so tests can stub them.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleState, sourceRoots } from "./dev-stack-extensions.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd, ...args) => {
	try {
		return { ok: true, out: git(cwd, ...args) };
	} catch (e) {
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
	}
};

export class UpdateError extends Error {}

/** Map branch name -> worktree path. */
export function worktrees(cwd) {
	const map = new Map();
	let cur;
	for (const line of git(cwd, "worktree", "list", "--porcelain").split("\n")) {
		if (line.startsWith("worktree ")) cur = line.slice(9);
		else if (line.startsWith("branch refs/heads/") && cur) map.set(line.slice(18), cur);
	}
	return map;
}

/** Tracked-or-not files that build/dev tooling rewrites; they never make a tree "dirty". */
export const GENERATED = ["apps/console/next-env.d.ts"];

export const isDirty = (wt) =>
	execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: wt, encoding: "utf8" }) // not git(): trim() would eat the first status column
		.split("\n")
		.filter(Boolean)
		.some((l) => !GENERATED.includes(l.slice(3)));

const isDoc = (f) => /^docs\//.test(f) || /\.mdx?$/.test(f);
const isTest = (f) => /\.test\.[cm]?[tj]sx?$/.test(f) || /(^|\/)(__tests__|fixtures)\//.test(f);

/** Classify changed paths. `refreshedExtensions`: names of rebuilt bundles. */
export function classify(files, refreshedExtensions = []) {
	const relevant = files.filter((f) => !isDoc(f) && !isTest(f));
	const agent = relevant.some((f) => f.startsWith("packages/agent/"));
	const console_ = relevant.filter((f) => f.startsWith("apps/console/"));
	const other = relevant.filter((f) => !f.startsWith("apps/console/"));
	let action = "none";
	if (refreshedExtensions.length || other.length) action = "restart";
	else if (console_.length) action = "reload";
	else if (files.length) action = "none"; // docs/tests only
	const lines = [];
	if (action === "restart") lines.push("restart the stack: npm run stack -- restart");
	else if (action === "reload") lines.push("console only: reload the window (Cmd-R)");
	else lines.push(files.length ? "docs/tests only: nothing to restart" : "already up to date");
	if (agent) lines.push("sfo-01 runs packages/agent: redeploy needed");
	return { action, agent, lines };
}

/**
 * Refresh stale den extension bundles for non-sandbox wolves. One function so it can move to a CLI later.
 * Returns [{wolf, den, dirs, backup}] of what was (or, dryRun, would be) refreshed.
 */
export async function refreshDenExtensions({ repo, wolvesDir, dryRun, log, now = () => new Date() }) {
	const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
	const refreshed = [];
	if (!fs.existsSync(wolvesDir)) return refreshed;
	const engine = await load("packages/engine/dist/index.js");
	const { AVAILABLE_EXTENSIONS } = await load("packages/cli/dist/extensions.js");
	const bundle = dryRun ? undefined : await load("packages/cli/dist/bundle.js");
	const cache = new Map();
	for (const entry of fs.readdirSync(wolvesDir).sort()) {
		const wolfDir = path.join(wolvesDir, entry);
		const yaml = path.join(wolfDir, "wolf.yaml");
		if (!fs.existsSync(yaml)) continue;
		try {
			const { config } = engine.loadWolfConfig(yaml, { home: os.homedir() });
			if (config.sandbox) continue;
			const den = fs.existsSync(path.join(wolfDir, "den")) ? path.join(wolfDir, "den") : wolfDir;
			const wanted = [...config.extensions]
				.map((k) => AVAILABLE_EXTENSIONS.find((e) => e.key === k || e.dir === k))
				.filter(Boolean);
			const stale = wanted.filter((e) => bundleState(path.join(den, "extensions", e.dir, "index.js"), sourceRoots(repo, e.dir), cache) !== "fresh");
			if (!stale.length) {
				log(`  extensions ${entry}: up to date`);
				continue;
			}
			const dirs = stale.map((e) => e.dir);
			const rec = { wolf: entry, den, dirs, keys: wanted.map((e) => e.key) };
			if (dryRun) {
				log(`  [dry-run] would refresh ${entry} extensions: ${dirs.join(", ")}`);
				refreshed.push(rec);
				continue;
			}
			const ts = now().toISOString().replace(/[-:T]/g, "").slice(0, 14);
			const extDir = path.join(den, "extensions");
			const staging = path.join(den, `.extensions.new-${ts}`);
			fs.rmSync(staging, { recursive: true, force: true });
			fs.mkdirSync(staging, { recursive: true });
			// Keep what we aren't rebuilding (owner extensions etc.), rebuild the stale ones.
			if (fs.existsSync(extDir)) fs.cpSync(extDir, staging, { recursive: true });
			for (const e of stale) {
				const ok = await bundle.buildDurableExtension(e.key, staging, extDir);
				if (!ok) throw new Error(`build of ${e.key} failed`);
			}
			rec.backup = path.join(den, `extensions.bak-${ts}`);
			if (fs.existsSync(extDir)) fs.renameSync(extDir, rec.backup);
			fs.renameSync(staging, extDir);
			log(`  refreshed ${entry} extensions: ${dirs.join(", ")} (backup ${rec.backup})`);
			refreshed.push(rec);
		} catch (err) {
			log(`  warning: extensions ${entry}: skipped (${err instanceof Error ? err.message.split("\n")[0] : err})`);
		}
	}
	return refreshed;
}

const defaultSteps = {
	build: (wt) => execFileSync("npx", ["turbo", "run", "build"], { cwd: wt, stdio: "inherit" }),
	refreshExtensions: refreshDenExtensions,
};

/** Returns {exitCode, classification, ...}; throws nothing for expected failures. */
export async function runUpdate({ argv = [], env = {}, cwd = process.cwd(), steps = {}, log = console.log, warn = console.warn } = {}) {
	const st = { ...defaultSteps, ...steps };
	const dryRun = argv.includes("--dry-run");
	const branch = argv.find((a) => !a.startsWith("--"));
	const runtime = env.RUNTIME_BRANCH || "stable";
	const wolvesDir = env.WOLVES_DIR || path.join(os.homedir(), "wolves", "local");
	const tag = dryRun ? "[dry-run] " : "";
	const fail = (msg) => {
		warn(`runtime:update: ${msg}`);
		return { exitCode: 1 };
	};

	// Merging is the owner's job now, on GitHub. Refuse the old argument instead of silently ignoring it.
	if (branch) {
		return fail(
			`this command no longer merges a branch (got "${branch}"): it only updates the ${runtime} runtime from origin/${runtime}. ` +
				"Release work with `wolfpack pr prepare`; the owner merges the PR, then run `npm run runtime:update` (or `wolfpack pr post-merge --apply`).",
		);
	}

	const wts = worktrees(cwd);
	const rtWt = wts.get(runtime);
	if (!rtWt) return fail(`branch ${runtime} is not checked out in any worktree`);
	log(`${tag}runtime ${runtime} @ ${rtWt}`);
	if (isDirty(rtWt)) return fail(`runtime worktree ${rtWt} has uncommitted changes; commit or stash them first`);

	// Fetch only the remote-tracking ref; nothing is pushed or merged anywhere.
	const remoteRef = `origin/${runtime}`;
	if (dryRun) log(`${tag}not fetching; using the local ${remoteRef}`);
	else {
		const f = tryGit(rtWt, "fetch", "origin", `+refs/heads/${runtime}:refs/remotes/origin/${runtime}`);
		if (!f.ok) return fail(`git fetch failed: ${f.out.split("\n")[0]}. Nothing was changed.`);
	}
	const target = tryGit(rtWt, "rev-parse", "--verify", `refs/remotes/origin/${runtime}^{commit}`);
	if (!target.ok) return fail(`cannot read ${remoteRef}: ${target.out.split("\n")[0]}`);

	const oldRuntime = git(rtWt, "rev-parse", "HEAD");
	// Runtime must be able to fast-forward to origin/<runtime>.
	if (!tryGit(rtWt, "merge-base", "--is-ancestor", oldRuntime, target.out).ok) {
		if (tryGit(rtWt, "merge-base", "--is-ancestor", target.out, oldRuntime).ok) {
			return fail(`${runtime} is ahead of ${remoteRef} (it has local commits that are not on the remote); there is nothing to fast-forward. Nothing was changed in ${rtWt}.`);
		}
		return fail(`${runtime} has diverged from ${remoteRef} (cannot fast-forward). Resolve by hand in ${rtWt}; nothing was changed there.`);
	}
	const files = git(rtWt, "diff", "--name-only", oldRuntime, target.out).split("\n").filter(Boolean);
	if (dryRun) {
		log(`${tag}would fast-forward ${runtime} to ${remoteRef} (${files.length} changed files)`);
		log(`${tag}would run: npx turbo run build`);
	} else {
		if (oldRuntime !== target.out) {
			const ff = tryGit(rtWt, "merge", "--ff-only", remoteRef);
			if (!ff.ok) return fail(`${runtime} cannot fast-forward to ${remoteRef}: ${ff.out}`);
			log(`fast-forwarded ${runtime} (${files.length} changed files)`);
		}
		log("building…");
		try {
			st.build(rtWt);
		} catch (err) {
			return fail(`build failed in ${rtWt}: ${err.message}`);
		}
	}
	log(`${tag}checking den extensions in ${wolvesDir}`);
	const refreshed = await st.refreshExtensions({ repo: rtWt, wolvesDir, dryRun, log });
	const cls = classify(files, refreshed.map((r) => r.wolf));
	log("");
	for (const l of cls.lines) log(`=> ${l}`);
	log(`\n${tag}summary: ${files.length} files changed, ${refreshed.length} den(s) refreshed, ${dryRun ? "nothing changed" : "nothing pushed"}`);
	return { exitCode: 0, classification: cls, files, refreshed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const r = await runUpdate({ argv: process.argv.slice(2), env: process.env });
	process.exit(r.exitCode);
}
