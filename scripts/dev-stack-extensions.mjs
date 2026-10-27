#!/usr/bin/env node
/**
 * Keep the sandbox dens' installed extension bundles current for `npm run dev:stack`.
 * wolfd loads `<den>/extensions/<dir>/index.js`, which nothing else rebuilds, so it silently goes stale.
 *
 *   node scripts/dev-stack-extensions.mjs <wolves-dir>        (run from dev-stack.sh; uses THIS checkout's CLI, not PATH)
 *
 * Wolf config and sandbox/den resolution reuse the engine's own loadWolfConfig + resolveSandbox (built dist), so this
 * cannot diverge from what wolfd does. Sandboxed wolves get `sandbox install-extensions` when their bundle is missing or
 * older than any source file; others are only warned about, never written. DEV_STACK_NO_EXT_INSTALL=1 skips all.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "dist", "fixtures", ".turbo"]);
const isTest = (f) => /\.test\.[cm]?[tj]sx?$/.test(f);

/** Newest mtime (ms) of the non-test files under `dir`; 0 when it has none. Memoized per call via `cache`. */
export function newestMtime(dir, cache = new Map()) {
	if (cache.has(dir)) return cache.get(dir);
	let newest = 0;
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		/* absent */
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) newest = Math.max(newest, newestMtime(p, cache));
		} else if (!isTest(e.name)) {
			newest = Math.max(newest, fs.statSync(p).mtimeMs);
		}
	}
	cache.set(dir, newest);
	return newest;
}

/** Source roots whose change invalidates a bundle: the extension's own dir plus every package's src (bundled in, incl. cli/src/bundle.ts). */
export function sourceRoots(repo, extDir) {
	const roots = [path.join(repo, "extensions", extDir)];
	const pkgs = path.join(repo, "packages");
	if (fs.existsSync(pkgs)) for (const p of fs.readdirSync(pkgs)) roots.push(path.join(pkgs, p, "src"));
	return roots;
}

/** "missing" | "stale" | "fresh" for an installed bundle against its sources. */
export function bundleState(bundlePath, roots, cache = new Map()) {
	let built;
	try {
		built = fs.statSync(bundlePath).mtimeMs;
	} catch {
		return "missing";
	}
	return roots.some((r) => newestMtime(r, cache) > built) ? "stale" : "fresh";
}

const real = (p) => {
	try {
		return fs.realpathSync(p);
	} catch {
		return undefined;
	}
};
const inside = (root, p) => p === root || p.startsWith(root + path.sep);

/**
 * One decision per wolf in `wolvesDir` that declares extensions.
 * action: "install" | "ok" | "warn" (non-sandbox, stale: never written) | "error" (reason in `error`).
 * `engine` supplies loadWolfConfig + resolveSandbox; `extensions` is the CLI's AVAILABLE_EXTENSIONS.
 */
export function planExtensionInstalls({ wolvesDir, repo, engine, extensions, home = os.homedir() }) {
	const dirOf = (k) => (extensions.find((e) => e.key === k) ?? extensions.find((e) => e.dir === k))?.dir;
	const cache = new Map();
	const plans = [];
	for (const entry of fs.existsSync(wolvesDir) ? fs.readdirSync(wolvesDir).sort() : []) {
		const wolfDir = path.join(wolvesDir, entry);
		const yamlPath = path.join(wolfDir, "wolf.yaml");
		if (!fs.existsSync(yamlPath)) continue;
		const plan = { wolf: entry, keys: [], action: "ok" };
		try {
			const { config } = engine.loadWolfConfig(yamlPath, { home });
			const wolf = config.identity.name;
			Object.assign(plan, { wolf, keys: [...config.extensions] });
			if (!plan.keys.length) continue;
			const unknown = plan.keys.filter((k) => !dirOf(k));
			const dirs = plan.keys.map(dirOf).filter(Boolean);
			let den = wolfDir;
			if (config.sandbox) {
				const root = path.resolve(config.sandbox.root);
				const shared = fs.existsSync(path.join(root, "dens"));
				den = engine.resolveSandbox(root, { wolf }).den; // throws on an unsafe wolf name
				Object.assign(plan, { sandboxRoot: root, shared });
			}
			plan.den = den;
			const states = dirs.map((d) => bundleState(path.join(den, "extensions", d, "index.js"), sourceRoots(repo, d), cache));
			plan.state = states.includes("missing") ? "missing" : states.includes("stale") ? "stale" : "fresh";
			if (unknown.length) plan.unknown = unknown;
			plan.action = plan.state === "fresh" ? "ok" : plan.sandboxRoot ? "install" : "warn";
			if (plan.action === "install") {
				const rr = real(plan.sandboxRoot);
				if (!fs.existsSync(path.join(plan.sandboxRoot, "snapshot.json"))) throw new Error(`${plan.sandboxRoot} has no snapshot.json (not a sandbox)`);
				// The den may not exist yet (install creates it); check its nearest existing ancestor instead.
				let probe = den;
				while (!real(probe)) probe = path.dirname(probe);
				if (!rr || !inside(rr, real(probe))) throw new Error(`den ${den} resolves outside the sandbox root ${plan.sandboxRoot}`);
			}
		} catch (err) {
			Object.assign(plan, { action: "error", error: err instanceof Error ? err.message : String(err) });
		}
		plans.push(plan);
	}
	return plans;
}

/** Report + act on the plans. `exec(file, args)` runs the CLI. Returns the plans. */
export function runPlans(plans, { cli, exec, log, warn }) {
	for (const p of plans) {
		if (p.unknown) warn(`dev-stack: warning: ${p.wolf}: unknown extension key(s) ${p.unknown.join(", ")} (not checked)`);
		if (p.action === "error") warn(`dev-stack: warning: ${p.wolf}: skipped (${p.error})`);
		else if (p.action === "ok") log(`dev-stack: extensions ${p.wolf}: up to date`);
		else if (p.action === "warn") warn(`dev-stack: warning: ${p.wolf}: installed extensions are ${p.state} vs source (non-sandbox den, not touched)`);
		else {
			// Shared root: this wolf's den under dens/. Single-wolf root: no --wolf (it must never grow a dens/).
			const args = [cli, "sandbox", "install-extensions", p.sandboxRoot, ...(p.shared ? ["--wolf", p.wolf] : []), "--extensions", p.keys.join(",")];
			try {
				exec(process.execPath, args);
				log(`dev-stack: extensions ${p.wolf}: installed (${p.keys.join(", ")}; was ${p.state})`);
			} catch (err) {
				warn(`dev-stack: warning: ${p.wolf}: extension install failed (${err instanceof Error ? err.message.split("\n")[0] : err})`);
			}
		}
	}
	return plans;
}

export async function main({ argv = process.argv.slice(2), env = process.env, repo, log = console.log, warn = console.warn, exec } = {}) {
	if (env.DEV_STACK_NO_EXT_INSTALL === "1") return void log("dev-stack: extension install skipped (DEV_STACK_NO_EXT_INSTALL=1)");
	if (!argv[0]) throw new Error("usage: dev-stack-extensions.mjs <wolves-dir> (no default: pass the WOLVES_DIR dev-stack.sh uses)");
	const wolvesDir = path.resolve(argv[0]);
	repo ??= path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	log(`dev-stack: checking extension bundles for wolves in ${wolvesDir}`);
	const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
	const engine = await load("packages/engine/dist/index.js");
	const { AVAILABLE_EXTENSIONS } = await load("packages/cli/dist/extensions.js");
	const plans = planExtensionInstalls({ wolvesDir, repo, engine, extensions: AVAILABLE_EXTENSIONS });
	const cli = path.join(repo, "packages/cli/dist/bin/wolfpack.js");
	runPlans(plans, { cli, exec: exec ?? ((file, args) => execFileSync(file, args, { stdio: ["ignore", "ignore", "inherit"] })), log, warn });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (err) {
		// A failed refresh must not block the stack; the warning says what to run.
		console.warn(`dev-stack: warning: extension refresh failed (${err?.message ?? err}); run \`sandbox install-extensions\` by hand`);
	}
}
