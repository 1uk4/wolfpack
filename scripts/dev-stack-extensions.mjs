#!/usr/bin/env node
/**
 * Keep the sandbox dens' installed extension bundles current for `npm run dev:stack`.
 * wolfd loads `<den>/extensions/<dir>/index.js`, which nothing else rebuilds, so it silently goes stale.
 *
 *   node scripts/dev-stack-extensions.mjs <wolves-dir>        (run from dev-stack.sh; uses THIS checkout's CLI, not PATH)
 *
 * Sandboxed wolves (wolf.yaml `sandbox.root` + `extensions`) get `sandbox install-extensions` when their bundle is
 * missing or older than any source file; others are only warned about, never written. DEV_STACK_NO_EXT_INSTALL=1 skips all.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const SKIP_DIRS = new Set(["node_modules", "dist", "fixtures", ".turbo"]);
const isTest = (f) => /\.test\.[cm]?[tj]sx?$/.test(f);

/** Newest mtime (ms) of the non-test files under `dir`; 0 when it has none. */
export function newestMtime(dir) {
	let newest = 0;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) newest = Math.max(newest, newestMtime(p));
		} else if (!isTest(e.name)) {
			newest = Math.max(newest, fs.statSync(p).mtimeMs);
		}
	}
	return newest;
}

/** Source roots whose change invalidates a bundle: the extension's own dir plus every package's src (bundled in). */
export function sourceRoots(repo, extDir) {
	const roots = [path.join(repo, "extensions", extDir)];
	const pkgs = path.join(repo, "packages");
	if (fs.existsSync(pkgs)) for (const p of fs.readdirSync(pkgs)) roots.push(path.join(pkgs, p, "src"));
	return roots;
}

/** "missing" | "stale" | "fresh" for an installed bundle against its sources. */
export function bundleState(bundlePath, roots) {
	let built;
	try {
		built = fs.statSync(bundlePath).mtimeMs;
	} catch {
		return "missing";
	}
	return roots.some((r) => newestMtime(r) > built) ? "stale" : "fresh";
}

const expandHome = (p) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * One decision per wolf in `wolvesDir` that declares extensions.
 * action: "install" (sandboxed, bundle missing/stale), "ok" (fresh), "warn" (non-sandbox and stale: never written).
 */
export function planExtensionInstalls({ wolvesDir, repo, dirOf }) {
	const plans = [];
	for (const name of fs.existsSync(wolvesDir) ? fs.readdirSync(wolvesDir).sort() : []) {
		const yamlPath = path.join(wolvesDir, name, "wolf.yaml");
		if (!fs.existsSync(yamlPath)) continue;
		let cfg;
		try {
			cfg = parse(fs.readFileSync(yamlPath, "utf8")) ?? {};
		} catch {
			continue;
		}
		const keys = Array.isArray(cfg.extensions) ? cfg.extensions.filter((k) => typeof k === "string") : [];
		if (!keys.length) continue;
		const wolf = typeof cfg.name === "string" ? cfg.name : name;
		const sandboxRoot = typeof cfg.sandbox?.root === "string" ? path.resolve(expandHome(cfg.sandbox.root)) : undefined;
		const den = sandboxRoot ? path.join(sandboxRoot, "dens", wolf) : path.resolve(expandHome(String(cfg.den ?? path.join(wolvesDir, name))));
		const states = keys.map((k) => {
			const dir = dirOf(k);
			return dir ? bundleState(path.join(den, "extensions", dir, "index.js"), sourceRoots(repo, dir)) : "fresh";
		});
		const worst = states.includes("missing") ? "missing" : states.includes("stale") ? "stale" : "fresh";
		const action = worst === "fresh" ? "ok" : sandboxRoot ? "install" : "warn";
		plans.push({ wolf, keys, sandboxRoot, den, state: worst, action });
	}
	return plans;
}

function main() {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const wolvesDir = path.resolve(expandHome(process.argv[2] ?? path.join(os.homedir(), "wolves", "dev")));
	if (process.env.DEV_STACK_NO_EXT_INSTALL === "1") {
		console.log("dev-stack: extension install skipped (DEV_STACK_NO_EXT_INSTALL=1)");
		return;
	}
	return import(pathToFileURL(path.join(repo, "packages/cli/dist/extensions.js")).href).then(({ AVAILABLE_EXTENSIONS }) => {
		const dirOf = (k) => AVAILABLE_EXTENSIONS.find((e) => e.key === k)?.dir;
		const cli = path.join(repo, "packages/cli/dist/bin/wolfpack.js");
		for (const p of planExtensionInstalls({ wolvesDir, repo, dirOf })) {
			if (p.action === "ok") console.log(`dev-stack: extensions ${p.wolf}: up to date`);
			else if (p.action === "warn") console.warn(`dev-stack: warning: ${p.wolf}: installed extensions are ${p.state} vs source (non-sandbox den, not touched)`);
			else {
				execFileSync(process.execPath, [cli, "sandbox", "install-extensions", p.sandboxRoot, "--wolf", p.wolf, "--extensions", p.keys.join(",")], { stdio: ["ignore", "ignore", "inherit"] });
				console.log(`dev-stack: extensions ${p.wolf}: installed (${p.keys.join(", ")}; was ${p.state})`);
			}
		}
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (err) {
		// A failed refresh must not block the stack; the warning says what to run.
		console.warn(`dev-stack: warning: extension install failed (${err?.message ?? err}); run \`sandbox install-extensions\` by hand`);
	}
}
