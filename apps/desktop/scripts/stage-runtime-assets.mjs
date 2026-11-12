#!/usr/bin/env node
/**
 * Add what the in-process embedder needs to the app runtime (work-wolfpack-07v3AmE), after build-runtime.mjs:
 *   node apps/desktop/scripts/stage-runtime-assets.mjs [runtime-dir]     (default apps/desktop/runtime)
 *
 *   <runtime>/node_modules/onnxruntime-node      JS + the darwin-arm64 natives only (binding + libonnxruntime.1.dylib, ~45 MB; linux/win32 left out)
 *   <runtime>/node_modules/onnxruntime-common    its one dependency
 *   <runtime>/node_modules/@huggingface/tokenizers
 *   (The Claude Agent SDK and the subscription bridge are NOT shipped: the app is API-key only, work-wolfpack-66JSDus.)
 *   <runtime>/embed-model/                       tokenizer.json, tokenizer_config.json, model.onnx (fp32 nomic-embed-text, 547 MB)
 *
 * The bundles in <runtime> import onnxruntime-node and @huggingface/tokenizers as externals; Node finds them in
 * <runtime>/node_modules (wolfd/wolfd.mjs walks up to it). Everything ships as extraResources, outside the asar.
 *
 * The model is bundled, not fetched on first run (a first-run download would be a fourth outbound host). The pinned
 * files and SHA-256s are scripts/fetch-embed-model.mjs's: this script runs it on <runtime>/embed-model, which keeps
 * files that already match and downloads (and verifies) the rest. Set WOLFPACK_EMBED_MODEL_SRC to a folder that already
 * holds the files to copy them first (offline builds, CI cache). The SHA-256 check happens AFTER that copy, so copied files are verified too.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const runtime = path.resolve(process.argv[2] ?? path.join(here, "../runtime"));
const MODEL_FILES = ["tokenizer.json", "tokenizer_config.json", "model.onnx"];

if (process.platform !== "darwin" || process.arch !== "arm64") {
	console.error("stage-runtime-assets: the friend app is darwin-arm64 only; run this on an Apple-silicon Mac (or a macos-15 runner).");
	process.exit(1);
}

// Resolve packages from where @wolfpack/kb (the owner of the optional deps) sees them.
const fromKb = createRequire(path.join(root, "packages/kb/package.json"));
const pkgDir = (name, from = fromKb) => {
	let dir = path.dirname(realpathSync(from.resolve(name)));
	while (!existsSync(path.join(dir, "package.json")) || JSON_name(dir) !== name) {
		const up = path.dirname(dir);
		if (up === dir) throw new Error(`cannot find the package root of ${name}`);
		dir = up;
	}
	return dir;
};
const JSON_name = (dir) => {
	try {
		return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
	} catch {
		return undefined;
	}
};

const nm = path.join(runtime, "node_modules");
rmSync(nm, { recursive: true, force: true });
const copy = (from, to, entries) => {
	mkdirSync(to, { recursive: true });
	for (const e of entries) cpSync(path.join(from, e), path.join(to, e), { recursive: true, dereference: true });
};

const ort = pkgDir("onnxruntime-node");
const ortCommon = pkgDir("onnxruntime-common", createRequire(path.join(ort, "package.json")));
const tok = pkgDir("@huggingface/tokenizers");
const native = path.join("bin", "napi-v6", "darwin", "arm64");
if (!existsSync(path.join(ort, native, "onnxruntime_binding.node"))) throw new Error(`onnxruntime-node has no ${native} (installed with ONNXRUNTIME_NODE_INSTALL=skip?)`);
copy(ort, path.join(nm, "onnxruntime-node"), ["package.json", "dist"]);
mkdirSync(path.join(nm, "onnxruntime-node", native), { recursive: true });
cpSync(path.join(ort, native), path.join(nm, "onnxruntime-node", native), { recursive: true, dereference: true });
// The binding links @rpath/libonnxruntime.1.dylib; the versioned file next to it is a byte-identical copy (45 MB) nothing loads.
rmSync(path.join(nm, "onnxruntime-node", native, "libonnxruntime.1.31.1.dylib"), { force: true });
copy(ortCommon, path.join(nm, "onnxruntime-common"), ["package.json", "dist", ...(existsSync(path.join(ortCommon, "lib")) ? ["lib"] : [])]);
copy(tok, path.join(nm, "@huggingface", "tokenizers"), ["package.json", "dist", ...(existsSync(path.join(tok, "LICENSE")) ? ["LICENSE"] : [])]);
console.log("node_modules: onnxruntime-node (darwin-arm64), onnxruntime-common, @huggingface/tokenizers");

const modelDir = path.join(runtime, "embed-model");
mkdirSync(modelDir, { recursive: true });
const src = process.env.WOLFPACK_EMBED_MODEL_SRC;
if (src) {
	for (const f of MODEL_FILES) if (existsSync(path.join(src, f)) && !existsSync(path.join(modelDir, f))) cpSync(path.join(src, f), path.join(modelDir, f));
}
// Verifies every file against the pinned SHA-256 (a mismatch deletes it and fails), fetching only what is missing.
const r = spawnSync(process.execPath, [path.join(root, "scripts/fetch-embed-model.mjs"), modelDir], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
for (const f of readdirSync(modelDir)) if (!MODEL_FILES.includes(f)) rmSync(path.join(modelDir, f), { force: true });
console.log(`embed-model: ${(statSync(path.join(modelDir, "model.onnx")).size / 1e6).toFixed(0)} MB model.onnx`);
