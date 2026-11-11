#!/usr/bin/env node
/**
 * A component's release version, from its nearest `<component>/vX.Y.Z` tag (the tags scripts/auto-tag.mjs creates on stable merges):
 *   HEAD at the tag    -> "X.Y.Z"
 *   HEAD past the tag  -> "X.Y.Z+<short sha>"   (a dev or ahead build; the +build part is ignored when versions are compared)
 *   never tagged       -> null
 * Components: console, hubd, wolfd (code in packages/harness), workerd.
 *
 * Release builds (scripts/release-build.sh, build-wolfd-release.sh --version X.Y.Z) pass `{ release: "X.Y.Z" }`: "X.Y.Z" when HEAD is at
 * `<component>/vX.Y.Z` (the normal case: release.yml checks out the tag), else "X.Y.Z+<short sha>" (a by-hand build off the tag).
 * So a published asset's VERSION matches its tag exactly, the same format a Mac checkout at that tag stamps.
 *
 * `describe` only sees tags reachable from HEAD. The Mac stack (`pnpm runtime:update`) runs from a working branch, so it reports
 * the newest tag merged back into that branch: until stable is merged back, the console sidebar shows "update available".
 * That prompt is correct (the Mac really is behind stable); merging stable back and re-running runtime:update clears it.
 *
 * Build time only: bundle builds and `pnpm runtime:update` write the result to a VERSION file the service reads at startup
 * (@wolfpack/protocol/health-lag `stampedVersion`). Nothing here runs inside a service.
 *
 *   node scripts/release-version.mjs <component>                  print the version (exit 1 when never tagged)
 *   node scripts/release-version.mjs <component> --release X.Y.Z  the VERSION of a release build of X.Y.Z (see above)
 *   node scripts/release-version.mjs --stamp-runtime [<repo>]     write the VERSION file of every component in a checkout
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where each component's VERSION file goes in a checkout (read back by the service: package root, or the console's cwd). */
export const RUNTIME_STAMPS = {
	console: "apps/console/VERSION",
	hubd: "packages/hubd/VERSION",
	wolfd: "packages/harness/VERSION",
	workerd: "packages/workerd/VERSION",
};

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export function resolveVersion(component, cwd = process.cwd(), { release } = {}) {
	if (release) {
		const tag = `${component}/v${release}`;
		let at = false;
		try {
			at = git(cwd, "rev-list", "-n", "1", tag) === git(cwd, "rev-parse", "HEAD");
		} catch {} // tag not present: a by-hand build
		return at ? release : `${release}+${git(cwd, "rev-parse", "--short", "HEAD")}`;
	}
	let tag;
	try {
		tag = git(cwd, "describe", "--tags", "--match", `${component}/v*`, "--abbrev=0", "HEAD");
	} catch {
		return null; // no such tag reachable
	}
	const m = /\/v(\d+\.\d+\.\d+(?:-main\.[1-9]\d*)?)$/.exec(tag);
	if (!m) return null;
	const head = git(cwd, "rev-parse", "HEAD");
	if (git(cwd, "rev-list", "-n", "1", tag) === head) return m[1];
	return `${m[1]}+${git(cwd, "rev-parse", "--short", "HEAD")}`;
}

/** Write every component's VERSION file under `root`; an untagged component gets none (its service then reports `<pkg>-dev`). Returns what was written. */
export function stampRuntime(root) {
	const out = {};
	for (const [component, rel] of Object.entries(RUNTIME_STAMPS)) {
		const file = path.join(root, rel);
		const v = resolveVersion(component, root);
		if (v) {
			fs.writeFileSync(file, `${v}\n`);
			out[component] = v;
		} else fs.rmSync(file, { force: true }); // never leave an older stamp behind
	}
	return out;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [arg, dir] = process.argv.slice(2);
	if (arg === "--stamp-runtime") {
		const root = path.resolve(dir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
		for (const [c, v] of Object.entries(stampRuntime(root))) console.log(`${c} ${v}`);
	} else if (arg && !arg.startsWith("-")) {
		const i = process.argv.indexOf("--release");
		const release = i > 0 ? process.argv[i + 1] : undefined;
		if (i > 0 && !/^\d+\.\d+\.\d+(-main\.[1-9]\d*)?$/.test(release ?? "")) {
			console.error("--release needs X.Y.Z or X.Y.Z-main.N");
			process.exit(2);
		}
		const v = resolveVersion(arg, process.cwd(), { release });
		if (!v) process.exit(1);
		console.log(v);
	} else {
		console.error("usage: release-version.mjs <component> [--release X.Y.Z] | --stamp-runtime [<repo>]");
		process.exit(2);
	}
}
