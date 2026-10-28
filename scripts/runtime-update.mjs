#!/usr/bin/env node
/**
 * npm run runtime:update [branch] [--dry-run]
 *
 * feature branch -> integration (wolf/1uk4) -> runtime (stable) -> build -> refresh den extensions -> push.
 * All branches are worktrees of one repo; located with `git worktree list`. Never rebases, never runs git in the
 * feature branch's worktree. Env: INTEGRATION_BRANCH (wolf/1uk4), RUNTIME_BRANCH (stable), WOLVES_DIR (~/wolves/local).
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

const isDirty = (wt) => git(wt, "status", "--porcelain", "--untracked-files=no") !== "";

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
	if (action === "restart") lines.push("restart the stack: Ctrl-C, then npm run dev:stack:desktop");
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
	const integration = env.INTEGRATION_BRANCH || "wolf/1uk4";
	const runtime = env.RUNTIME_BRANCH || "stable";
	const wolvesDir = env.WOLVES_DIR || path.join(os.homedir(), "wolves", "local");
	const tag = dryRun ? "[dry-run] " : "";
	const fail = (msg) => {
		warn(`runtime:update: ${msg}`);
		return { exitCode: 1 };
	};

	const wts = worktrees(cwd);
	const intWt = wts.get(integration);
	const rtWt = wts.get(runtime);
	if (!intWt) return fail(`branch ${integration} is not checked out in any worktree`);
	if (!rtWt) return fail(`branch ${runtime} is not checked out in any worktree`);
	log(`${tag}integration ${integration} @ ${intWt}\n${tag}runtime ${runtime} @ ${rtWt}`);

	if (isDirty(rtWt)) return fail(`runtime worktree ${rtWt} has uncommitted changes; commit or stash them first`);
	if (branch) {
		if (isDirty(intWt)) return fail(`integration worktree ${intWt} has uncommitted changes; commit or stash them first`);
		if (!tryGit(intWt, "rev-parse", "--verify", `${branch}^{commit}`).ok) return fail(`unknown branch ${branch}`);
	}

	const oldRuntime = git(rtWt, "rev-parse", "HEAD");
	let target = git(intWt, "rev-parse", "HEAD"); // tip the runtime will be fast-forwarded to

	if (branch) {
		if (dryRun) {
			log(`${tag}would merge ${branch} into ${integration}`);
			target = branch; // approximation: diff the branch tip
			const ancestor = tryGit(intWt, "merge-base", "--is-ancestor", runtime, branch).ok;
			if (!ancestor) log(`${tag}note: ${branch} does not contain ${runtime}; classification is approximate`);
		} else {
			const m = tryGit(intWt, "merge", "--no-edit", branch);
			if (!m.ok) {
				const files = tryGit(intWt, "diff", "--name-only", "--diff-filter=U").out.split("\n").filter(Boolean);
				tryGit(intWt, "merge", "--abort");
				warn(`runtime:update: merge of ${branch} into ${integration} conflicted; aborted (tree is clean). Conflicting files:`);
				for (const f of files) warn(`  ${f}`);
				if (!files.length) warn(m.out);
				return { exitCode: 1, conflicts: files };
			}
			log(`merged ${branch} into ${integration}`);
			target = git(intWt, "rev-parse", "HEAD");
		}
	}

	// Runtime must be able to fast-forward to the integration tip.
	if (!tryGit(rtWt, "merge-base", "--is-ancestor", oldRuntime, target).ok) {
		return fail(`${runtime} has diverged from ${integration} (cannot fast-forward). Resolve by hand in ${rtWt}; nothing was changed there.`);
	}
	const files = git(rtWt, "diff", "--name-only", oldRuntime, target).split("\n").filter(Boolean);
	if (dryRun) {
		log(`${tag}would fast-forward ${runtime} to ${integration} (${files.length} changed files)`);
		log(`${tag}would run: npx turbo run build`);
	} else {
		if (oldRuntime !== target) {
			const ff = tryGit(rtWt, "merge", "--ff-only", integration);
			if (!ff.ok) return fail(`${runtime} cannot fast-forward to ${integration}: ${ff.out}`);
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

	let pushed = false;
	if (dryRun) log(`${tag}would push origin ${integration} ${runtime}`);
	else {
		const p = tryGit(rtWt, "push", "origin", integration, runtime);
		pushed = p.ok;
		if (!p.ok) warn(`runtime:update: warning: push failed (${p.out.split("\n")[0]}); local update is complete`);
	}
	log(`\n${tag}summary: ${branch ? `merged ${branch}; ` : ""}${files.length} files changed, ${refreshed.length} den(s) refreshed, ${dryRun ? "nothing changed" : pushed ? "pushed" : "not pushed"}`);
	return { exitCode: 0, classification: cls, files, refreshed, pushed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const r = await runUpdate({ argv: process.argv.slice(2), env: process.env });
	process.exit(r.exitCode);
}
