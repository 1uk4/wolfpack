#!/usr/bin/env node
/**
 * Runs turbo with ONE local cache folder for every worktree and checkout on this machine
 * (~/.cache/wolfpack/turbo), so a second worktree's cold build restores the first one's output.
 * turbo.json cannot say this: cacheDir is relative to each checkout and does not expand "~".
 * In CI nothing is set (the turbo cache is not restored there); TURBO_CACHE_DIR wins when set.
 * Runs `pnpm exec turbo`; without pnpm on the PATH it falls back to `npx turbo` (npm checkouts, the release path).
 * Usage: node scripts/turbo.mjs run build ...   (root scripts call it as `node scripts/turbo.mjs ...`)
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function turboCacheDir(env = process.env, home = os.homedir()) {
	if (env.TURBO_CACHE_DIR) return env.TURBO_CACHE_DIR;
	if (env.CI) return undefined;
	return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "wolfpack", "turbo");
}

/**
 * Run turbo and return the exit code to use (never throws). `deps` is injectable for tests.
 * A child killed by a signal comes back as 128 + the signal number, like a shell reports it.
 */
export function runTurbo(args, deps = {}) {
	const {
		spawnSync: spawn = spawnSync,
		env = process.env,
		home = os.homedir(),
		platform = process.platform,
		log = (m) => console.error(m),
	} = deps;
	const dir = turboCacheDir(env, home);
	const childEnv = dir ? { ...env, TURBO_CACHE_DIR: dir } : env;
	// pnpm and npx are .cmd shims on Windows, which spawn only runs through a shell.
	const opts = { stdio: "inherit", env: childEnv, ...(platform === "win32" ? { shell: true } : {}) };

	let r = spawn("pnpm", ["exec", "turbo", ...args], opts);
	if (r.error?.code === "ENOENT") {
		log("turbo.mjs: pnpm not found on the PATH; falling back to `npx turbo`");
		r = spawn("npx", ["turbo", ...args], opts);
	}
	if (r.error) {
		log(`turbo.mjs: ${r.error.message}`);
		return 1;
	}
	if (r.signal) return 128 + (os.constants.signals[r.signal] ?? 0);
	return r.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(runTurbo(process.argv.slice(2)));
}
