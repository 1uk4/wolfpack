#!/usr/bin/env node
/**
 * wolfpack preview <ref> | status | off [--dry-run]
 *
 * Try a branch on the live Mac stack, and get back to stable, with one command each. The runtime is the stable worktree
 * (`git worktree list`, env RUNTIME_BRANCH, default stable) run by launchd `com.wolfpack.stack`. State lives in
 * ~/.wolfpack/preview/state.json: {previousRef, previousBranch, previewRef, previewSha, startedAt, phase, runtimeDir}.
 *
 * on <ref>: refuse a dirty runtime or an active preview of another ref; fetch; record state; while the wolves are still up,
 * check out the SHA (detached), install and build. A failed build checks the previous ref back out, rebuilds it and ends
 * "build-failed"; the stack is never stopped. After a good build a detached helper (runtime-preview-switch.mjs, copied to
 * ~/.wolfpack/preview/ so it survives the tree switch) restarts the stack and polls /healthz.
 * off: recovers from the state file alone (works after a crash at any phase): previous branch, fast-forward, build, same helper.
 * Never pushes or merges a branch: only fetch, rev-parse, checkout and `merge --ff-only` of the previous branch's origin.
 * Steps (git, build, spawnHelper) are injectable so tests can stub them. Env: HOME, RUNTIME_BRANCH, STACK_LABEL, STACK_PORT.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommands, choosePm, isDirty, probePnpm, worktrees } from "./runtime-update.mjs";

const realGit = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Read at load time: by the time the helper is spawned the checked-out tree may be a branch that has no such file.
const HELPER_SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime-preview-switch.mjs"), "utf8");

const defaultSteps = {
	git: realGit,
	build: (wt) => {
		const { pm } = choosePm(wt, { pnpmFound: probePnpm });
		for (const { cmd, args } of buildCommands(pm)) execFileSync(cmd, args, { cwd: wt, stdio: "inherit", shell: process.platform === "win32" });
	},
	/** Copy the helper out of the runtime tree and run it detached, output to the last-run log. */
	spawnHelper: ({ args, dir, logFile }) => {
		fs.mkdirSync(dir, { recursive: true });
		const copy = path.join(dir, "runtime-preview-switch.mjs");
		fs.writeFileSync(copy, HELPER_SRC);
		const fd = fs.openSync(logFile, "w");
		spawn(process.execPath, [copy, ...args], { detached: true, stdio: ["ignore", fd, fd] }).unref();
	},
};

export async function runPreview({ argv = [], env = {}, cwd = process.cwd(), steps = {}, log = console.log, warn = console.warn } = {}) {
	const st = { ...defaultSteps, ...steps };
	const git = (wt, ...a) => st.git(wt, ...a);
	const tryGit = (wt, ...a) => {
		try {
			return { ok: true, out: git(wt, ...a) };
		} catch (e) {
			return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message) };
		}
	};
	const dryRun = argv.includes("--dry-run");
	const pos = argv.filter((a) => !a.startsWith("--"));
	const sub = pos[0];
	const home = env.HOME || os.homedir();
	const dir = path.join(home, ".wolfpack", "preview");
	const stateFile = path.join(dir, "state.json");
	const logFile = path.join(dir, "last-run.log");
	const plist = path.join(home, "Library", "LaunchAgents", "com.wolfpack.stack.plist");
	const label = env.STACK_LABEL || "com.wolfpack.stack";
	const port = String(env.STACK_PORT || 7141);
	const runtimeBranch = env.RUNTIME_BRANCH || "stable";
	const tag = dryRun ? "[dry-run] " : "";
	const fail = (msg) => {
		warn(`preview: ${msg}`);
		return { exitCode: 1 };
	};
	const readState = () => {
		try {
			return JSON.parse(fs.readFileSync(stateFile, "utf8"));
		} catch {
			return undefined;
		}
	};
	const writeState = (s) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`);
	};
	const helper = (okPhase, clear) => st.spawnHelper({ dir, logFile, args: [stateFile, plist, label, port, okPhase, clear ? "1" : "0"] });
	const state = readState();

	if (!sub) return fail("usage: wolfpack preview <ref> | status | off [--dry-run]");

	if (sub === "status") {
		if (!state) {
			log("stable, no preview");
			return { exitCode: 0 };
		}
		log(`preview ${state.previewRef} @ ${state.previewSha}`);
		log(`phase: ${state.phase}, started ${state.startedAt}, previous ${state.previousBranch ?? state.previousRef}`);
		if (fs.existsSync(logFile)) for (const l of fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-5)) log(`  ${l}`);
		return { exitCode: 0, state };
	}

	const activePreview = state && state.phase !== "build-failed" ? state : undefined;
	const rtWt = state?.runtimeDir ?? worktrees(cwd).get(runtimeBranch);
	if (!rtWt) return fail(`branch ${runtimeBranch} is not checked out in any worktree`);
	log(`${tag}runtime @ ${rtWt}`);

	if (sub === "off") {
		if (!state) {
			log("stable, no preview: nothing to do");
			return { exitCode: 0 };
		}
		if (isDirty(rtWt)) return fail(`runtime worktree ${rtWt} has uncommitted changes; commit or stash them first. Nothing was changed.`);
		const branch = state.previousBranch;
		if (dryRun) {
			log(`${tag}would check out ${branch ?? state.previousRef}, fast-forward it to origin, install and build`);
			log(`${tag}would restart ${label}, wait for /healthz on ${port}, then clear ${stateFile}`);
			return { exitCode: 0 };
		}
		const co = branch ? tryGit(rtWt, "checkout", branch) : tryGit(rtWt, "checkout", "--detach", state.previousRef);
		if (!co.ok) return fail(`cannot check out ${branch ?? state.previousRef}: ${co.out.split("\n")[0]}`);
		if (branch) {
			if (!tryGit(rtWt, "fetch", "origin", branch).ok) warn("preview: git fetch failed (offline?); using the local branch");
			const remote = tryGit(rtWt, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`);
			if (remote.ok && remote.out !== git(rtWt, "rev-parse", "HEAD")) {
				const ff = tryGit(rtWt, "merge", "--ff-only", `origin/${branch}`);
				if (!ff.ok) warn(`preview: ${branch} cannot fast-forward to origin/${branch}; staying at the local ${branch}`);
			}
		}
		writeState({ ...state, phase: "restoring" });
		try {
			st.build(rtWt);
		} catch (err) {
			return fail(`build of ${branch ?? state.previousRef} failed: ${err.message}. The stack was not touched; state kept, run \`wolfpack preview off\` again.`);
		}
		helper(branch ?? "stable", true);
		log("restoring stable: the wolf session running this command will end. Run `wolfpack preview status` from Terminal.");
		return { exitCode: 0 };
	}

	// on <ref>
	const ref = sub;
	if (ref.startsWith("-")) return fail(`"${ref}" looks like an option, not a ref. Nothing was changed.`);
	if (activePreview && activePreview.previewRef !== ref) {
		return fail(`a preview of ${activePreview.previewRef} is already active (${activePreview.phase}); run \`wolfpack preview off\` first. Nothing was changed.`);
	}
	if (isDirty(rtWt)) return fail(`runtime worktree ${rtWt} has uncommitted changes; commit or stash them first. Nothing was changed.`);
	if (dryRun) log(`${tag}not fetching; using local refs`);
	else if (!tryGit(rtWt, "fetch", "origin").ok) return fail("git fetch failed. Nothing was changed.");
	let sha;
	for (const cand of [`refs/remotes/origin/${ref}`, ref]) {
		const r = tryGit(rtWt, "rev-parse", "--verify", `${cand}^{commit}`);
		if (r.ok) {
			sha = r.out;
			break;
		}
	}
	if (!sha) return fail(`cannot resolve "${ref}". Nothing was changed.`);

	const head = git(rtWt, "rev-parse", "HEAD");
	const abbrev = git(rtWt, "rev-parse", "--abbrev-ref", "HEAD");
	// Any existing state (even build-failed) wins over HEAD: a failed restore can leave HEAD on the preview SHA.
	const previousRef = state?.previousRef ?? head;
	const previousBranch = state ? state.previousBranch : abbrev === "HEAD" ? null : abbrev;
	if (dryRun) {
		log(`${tag}would record state in ${stateFile} (previous ${previousBranch ?? previousRef})`);
		log(`${tag}would check out ${sha.slice(0, 8)} (${ref}) detached, install and build while the wolves stay up`);
		log(`${tag}then restart ${label}, wait for /healthz on ${port}`);
		return { exitCode: 0 };
	}
	const priorStateText = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : undefined;
	writeState({ previousRef, previousBranch, previewRef: ref, previewSha: sha, startedAt: new Date().toISOString(), phase: "building", runtimeDir: rtWt });
	const co = tryGit(rtWt, "checkout", "--detach", sha);
	if (!co.ok) {
		if (priorStateText === undefined) fs.rmSync(stateFile, { force: true });
		else fs.writeFileSync(stateFile, priorStateText);
		return fail(`cannot check out ${sha}: ${co.out.split("\n")[0]}`);
	}
	try {
		st.build(rtWt);
	} catch (err) {
		warn(`preview: build of ${ref} failed: ${err.message}. Restoring ${previousBranch ?? previousRef}; the stack was not stopped.`);
		if (previousBranch) tryGit(rtWt, "checkout", previousBranch);
		else tryGit(rtWt, "checkout", "--detach", previousRef);
		try {
			st.build(rtWt);
		} catch (err2) {
			warn(`preview: rebuild of the previous ref failed too: ${err2.message}`);
		}
		writeState({ ...readState(), phase: "build-failed" });
		return { exitCode: 1 };
	}
	writeState({ ...readState(), phase: "switching" });
	helper("running", false);
	log(`previewing ${ref} (${sha.slice(0, 8)}): the stack is restarting, so the wolf session running this command will end.`);
	log("Run `wolfpack preview status` from Terminal; `wolfpack preview off` returns to stable.");
	return { exitCode: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const r = await runPreview({ argv: process.argv.slice(2), env: process.env });
	process.exit(r.exitCode);
}
