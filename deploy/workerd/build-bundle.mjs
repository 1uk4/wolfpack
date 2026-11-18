#!/usr/bin/env node
/**
 * Build a single-file workerd bundle for sfo-01 (no node_modules or npm on the VPS, same idea as the harness bundle).
 *   node deploy/workerd/build-bundle.mjs [out-dir]     (run after `npx tsc --build`; default out-dir: deploy/workerd/out)
 * Writes <out>/workerd.mjs, <out>/RUNBOOK.md, <out>/VERSION (the release version from the workerd/vX.Y.Z tag, scripts/release-version.mjs; <package version>-dev+<sha> when untagged) and prints the sha256 of workerd.mjs.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { resolveVersion } from "../../scripts/release-version.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? path.join(here, "out"));
mkdirSync(out, { recursive: true });
await esbuild.build({
	entryPoints: [path.join(root, "packages/workerd/src/bin/workerd.ts")],
	outfile: path.join(out, "workerd.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	// CJS deps (ws, yaml, qrcode-terminal) need require() inside an ESM bundle.
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
	external: ["bufferutil", "utf-8-validate", "onnxruntime-node", "@huggingface/tokenizers"], // optional: ws native addons (ws falls back to plain JS) and the ONNX embedder packages (loaded at runtime only if installed)
	logLevel: "info",
});
copyFileSync(path.join(here, "RUNBOOK.md"), path.join(out, "RUNBOOK.md"));
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = resolveVersion("workerd", root) ?? `${JSON.parse(readFileSync(path.join(root, "packages/workerd/package.json"), "utf8")).version}-dev+${sha}`;
writeFileSync(path.join(out, "VERSION"), `${version}\n`);
console.log(`workerd bundle ${version} sha256 ${createHash("sha256").update(readFileSync(path.join(out, "workerd.mjs"))).digest("hex")}`);
