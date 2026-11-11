#!/usr/bin/env node
/**
 * pnpm runtime:update [--dry-run]     (npm run runtime:update on a checkout that is still on npm)
 *
 * origin/stable -> runtime (stable worktree) -> build -> refresh den extensions. Fetches, fast-forwards only (refuses if the
 * runtime cannot fast-forward), never merges a branch, never rebases, never pushes. Merging into stable is the owner's job on
 * GitHub (`wolfpack pr prepare` opens the PR). A branch argument is refused. All branches are worktrees of one repo; located
 * with `git worktree list`. Env: RUNTIME_BRANCH (stable), WOLVES_DIR (~/wolves/local).
 * Build and extension refresh are injectable (`steps`) so tests can stub them.
 * Package manager: when the commit being deployed has pnpm-lock.yaml AND pnpm is on the PATH, it installs with
 * `pnpm install --frozen-lockfile --prefer-offline` and builds with `node scripts/turbo.mjs run build` (the shared turbo cache);
 * otherwise the old npm path runs unchanged (`npx turbo run build`, no install). The runtime checkout moves npm -> pnpm
 * when stable first carries pnpm-lock.yaml, so the choice is made on the target commit, not on the tree as it is now.
 */
import { execFileSync, spawnSync } from "node:child_process";
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

/** Commands that install and build one checkout, per package manager. */
export function buildCommands(pm) {
	if (pm === "pnpm") {
		return [
			{ cmd: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"] },
			{ cmd: "node", args: ["scripts/turbo.mjs", "run", "build"] },
		];
	}
	return [{ cmd: "npx", args: ["turbo", "run", "build"] }];
}

/** Is pnpm usable from here? (A PATH lookup; corepack shims count when `corepack enable` was run.) */
export const probePnpm = () => {
	const r = spawnSync("pnpm", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
	return !r.error && r.status === 0;
};

/**
 * "pnpm" when the checkout has pnpm-lock.yaml (`ref`: look in that commit, else on disk) and pnpm is found; else "npm".
 * `note` explains the one surprising case (lockfile but no pnpm).
 */
export function choosePm(wt, { ref, pnpmFound = probePnpm } = {}) {
	const hasLock = ref ? tryGit(wt, "cat-file", "-e", `${ref}:pnpm-lock.yaml`).ok : fs.existsSync(path.join(wt, "pnpm-lock.yaml"));
	if (!hasLock) return { pm: "npm" };
	const found = typeof pnpmFound === "function" ? pnpmFound() : pnpmFound;
	return found ? { pm: "pnpm" } : { pm: "npm", note: "pnpm-lock.yaml found but pnpm is not installed; falling back to npm (run `corepack enable` to get pnpm)" };
}

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
export function classify(files, refreshedExtensions = [], pm = "npm") {
	const relevant = files.filter((f) => !isDoc(f) && !isTest(f));
	const agent = relevant.some((f) => f.startsWith("packages/agent/"));
	const console_ = relevant.filter((f) => f.startsWith("apps/console/"));
	const other = relevant.filter((f) => !f.startsWith("apps/console/"));
	let action = "none";
	if (refreshedExtensions.length || other.length) action = "restart";
	else if (console_.length) action = "reload";
	else if (files.length) action = "none"; // docs/tests only
	const lines = [];
	if (action === "restart") lines.push(pm === "pnpm" ? "restart the stack: pnpm stack restart" : "restart the stack: npm run stack -- restart");
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

const defaultSteps = (pnpmFound) => ({
	build: (wt) => {
		const { pm } = choosePm(wt, { pnpmFound });
		for (const { cmd, args } of buildCommands(pm)) execFileSync(cmd, args, { cwd: wt, stdio: "inherit", shell: process.platform === "win32" });
		// Release versions for /healthz and update notices: <component>/vX.Y.Z tag -> packages/*/VERSION, apps/console/VERSION (gitignored).
		execFileSync(process.execPath, [path.join(wt, "scripts/release-version.mjs"), "--stamp-runtime", wt], { cwd: wt, stdio: "inherit" });
	},
	refreshExtensions: refreshDenExtensions,
});

/** Returns {exitCode, classification, ...}; throws nothing for expected failures. */
export async function runUpdate({ argv = [], env = {}, cwd = process.cwd(), steps = {}, pnpmFound = probePnpm, log = console.log, warn = console.warn } = {}) {
	const st = { ...defaultSteps(pnpmFound), ...steps };
	const dryRun = argv.includes("--dry-run");
	const shaAt = argv.indexOf("--sha");
	const sha = shaAt >= 0 ? argv[shaAt + 1] : undefined; // main channel: the exact commit the manifest names
	const branch = argv.find((a, i) => !a.startsWith("--") && (shaAt < 0 || i !== shaAt + 1));
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
				"Release work with `wolfpack pr prepare`; the owner merges the PR, then run `pnpm runtime:update` (`npm run runtime:update` on a checkout that is still on npm; or `wolfpack pr post-merge --apply`).",
		);
	}

	if (shaAt >= 0 && !/^[0-9a-f]{40}$/.test(sha ?? "")) return fail("--sha needs a full 40-character commit id");
	const wts = worktrees(cwd);
	// After a --sha run the runtime worktree is detached; the STACK_RUNTIME path finds it again so a plain run returns to the branch.
	const detachedRt = env.STACK_RUNTIME && [...git(cwd, "worktree", "list", "--porcelain").split("\n")].includes(`worktree ${env.STACK_RUNTIME}`) ? env.STACK_RUNTIME : undefined;
	const rtWt = wts.get(runtime) ?? detachedRt;
	if (!rtWt) return fail(`branch ${runtime} is not checked out in any worktree`);
	log(`${tag}runtime ${runtime} @ ${rtWt}`);
	if (isDirty(rtWt)) return fail(`runtime worktree ${rtWt} has uncommitted changes; commit or stash them first`);
	if (sha) {
		// Main channel: the exact commit the manifest names, detached; any branch on origin may carry it. Build and refresh as usual.
		const f = tryGit(rtWt, "fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*");
		if (!f.ok) return fail(`git fetch failed: ${f.out.split("\n")[0]}. Nothing was changed.`);
		const full = tryGit(rtWt, "rev-parse", "--verify", `${sha}^{commit}`);
		if (!full.ok) return fail(`commit ${sha} is not in the repository after fetching origin. Nothing was changed.`);
		// The object may exist locally from an old fetch; it must still be reachable from a branch on origin.
		const onOrigin = tryGit(rtWt, "branch", "-r", "--contains", full.out);
		if (!onOrigin.ok || !onOrigin.out.split("\n").some((l) => /^\s*origin\/(?!HEAD)\S/.test(l))) return fail(`commit ${sha} is not reachable from any origin branch. Nothing was changed.`);
		const before = git(rtWt, "rev-parse", "HEAD");
		const changed = git(rtWt, "diff", "--name-only", before, full.out).split("\n").filter(Boolean);
		if (!dryRun) {
			const co = tryGit(rtWt, "checkout", "--detach", full.out);
			if (!co.ok) return fail(`cannot check out ${sha}: ${co.out.split("\n")[0]}`);
			try {
				st.build(rtWt);
			} catch (err) {
				return fail(`build failed in ${rtWt}: ${err.message}`);
			}
		}
		const refreshedSha = await st.refreshExtensions({ repo: rtWt, wolvesDir, dryRun, log });
		const clsSha = classify(changed, refreshedSha.map((r) => r.wolf), choosePm(rtWt, { pnpmFound }).pm);
		for (const l of clsSha.lines) log(`=> ${l}`);
		return { exitCode: 0, classification: clsSha, files: changed, refreshed: refreshedSha };
	}
	if (!wts.get(runtime) && !dryRun) {
		const co = tryGit(rtWt, "checkout", runtime);
		if (!co.ok) return fail(`cannot return ${rtWt} to ${runtime}: ${co.out.split("\n")[0]}`);
	}

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
		const { pm, note } = choosePm(rtWt, { ref: target.out, pnpmFound });
		if (note) log(`${tag}${note}`);
		for (const { cmd, args } of buildCommands(pm)) log(`${tag}would run: ${cmd} ${args.join(" ")}`);
	} else {
		if (oldRuntime !== target.out) {
			const ff = tryGit(rtWt, "merge", "--ff-only", remoteRef);
			if (!ff.ok) return fail(`${runtime} cannot fast-forward to ${remoteRef}: ${ff.out}`);
			log(`fast-forwarded ${runtime} (${files.length} changed files)`);
		}
		const chosen = choosePm(rtWt, { pnpmFound });
		if (chosen.note) log(chosen.note);
		log(`building with ${chosen.pm}…`);
		try {
			st.build(rtWt);
		} catch (err) {
			return fail(`build failed in ${rtWt}: ${err.message}`);
		}
	}
	log(`${tag}checking den extensions in ${wolvesDir}`);
	const refreshed = await st.refreshExtensions({ repo: rtWt, wolvesDir, dryRun, log });
	const cls = classify(files, refreshed.map((r) => r.wolf), choosePm(rtWt, { ref: dryRun ? target.out : undefined, pnpmFound }).pm);
	log("");
	for (const l of cls.lines) log(`=> ${l}`);
	log(`\n${tag}summary: ${files.length} files changed, ${refreshed.length} den(s) refreshed, ${dryRun ? "nothing changed" : "nothing pushed"}`);
	return { exitCode: 0, classification: cls, files, refreshed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const r = await runUpdate({ argv: process.argv.slice(2), env: process.env });
	process.exit(r.exitCode);
}
