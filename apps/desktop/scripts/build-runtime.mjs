#!/usr/bin/env node
/**
 * Build the runtime the desktop app starts on the owner's Mac (work-wolfpack-wOBXF9f): hubd, workerd, wolfd and the
 * memory extension, as single files that run under Electron's own Node (ELECTRON_RUN_AS_NODE=1).
 *   node apps/desktop/scripts/build-runtime.mjs [out-dir]     (run after `pnpm -r --filter "./packages/*" build`; default out-dir: apps/desktop/runtime)
 * Writes <out>/{hubd,workerd,wolfd}.mjs and <out>/extensions/wolfpack-memory/index.js, then prints each size.
 * The supervisor (electron/supervisor.cjs) reads this layout; electron-builder ships it as extraResources "runtime".
 */
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { EXTERNALS } from "./runtime-externals.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const out = path.resolve(process.argv[2] ?? path.join(here, "../runtime"));
mkdirSync(out, { recursive: true });

const entries = {
	hubd: "packages/hubd/src/cli.ts",
	workerd: "packages/workerd/src/bin/workerd.ts",
	wolfd: "packages/harness/src/bin/wolfd.ts",
};
// wolfd sits in its own folder: it reads prompts/ and standards/ from beside the bundle and agents/ (helper profiles) from one level up.
const bundleFile = (name) => (name === "wolfd" ? "wolfd/wolfd.mjs" : `${name}.mjs`);
for (const [name, entry] of Object.entries(entries)) {
	await esbuild.build({
		entryPoints: [path.join(root, entry)],
		outfile: path.join(out, bundleFile(name)),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		// CJS deps (ws, yaml, ...) need require() inside an ESM bundle.
		// WOLFPACK_EXIT_WITH_PARENT=1 (set by the supervisor): exit when the parent process is gone, so a crashed app never leaves orphans.
		banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url); if (process.env.WOLFPACK_EXIT_WITH_PARENT === '1') { const __p = process.ppid; setInterval(() => { if (process.ppid !== __p) { process.kill(process.pid, 'SIGTERM'); setTimeout(() => process.exit(1), 3000).unref(); } }, 1000).unref(); }" },
		// Shipped in <out>/node_modules by stage-runtime-assets.mjs, or optional; the list lives in runtime-externals.mjs, which check-app.mjs verifies.
		external: EXTERNALS,
		logLevel: "error",
	});
	console.log(`${bundleFile(name)} ${(statSync(path.join(out, bundleFile(name))).size / 1e6).toFixed(1)} MB`);
}

for (const [from, to] of [["prompts", "wolfd/prompts"], ["standards", "wolfd/standards"], ["agents", "agents"]]) {
	rmSync(path.join(out, to), { recursive: true, force: true });
	cpSync(path.join(root, "packages/agents", from), path.join(out, to), { recursive: true });
}

// The memory extension is a den extension: a self-contained index.js the wolf loads from <den>/extensions/wolfpack-memory/.
const { buildDurableExtension } = await import(path.join(root, "packages/cli/dist/bundle.js"));
const extDir = path.join(out, "extensions");
if (!(await buildDurableExtension("memory", extDir))) throw new Error("memory extension did not build");
console.log(`extensions/wolfpack-memory/index.js ${(statSync(path.join(extDir, "wolfpack-memory/index.js")).size / 1e6).toFixed(1)} MB`);
