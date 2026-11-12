#!/usr/bin/env node
/**
 * Post-build smoke for the packaged app (work-wolfpack-07v3AmE):
 *   node apps/desktop/scripts/check-app.mjs <path to Wolfpack Console.app> [--signed]
 *
 * 1. The natives and the embedding model are inside Contents/Resources/runtime.
 * 2. With the app's own binary as Node (ELECTRON_RUN_AS_NODE=1), every required external a runtime bundle
 *    imports (scripts/runtime-externals.mjs) resolves from that bundle's folder to a package inside
 *    Resources/runtime. Nothing is started. A missing package (the Agent SDK once was) fails here, not at first launch.
 *    Also: no bundle holds the subscription bridge's code or statically imports the Agent SDK.
 * 3. --signed: codesign --verify --deep --strict, spctl -a -vv, xcrun stapler validate.
 * Exit 0 = all pass.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { REQUIRED_EXTERNALS } from "./runtime-externals.mjs";

const app = path.resolve(process.argv[2] ?? "");
const signed = process.argv.includes("--signed");
if (!process.argv[2] || !app.endsWith(".app") || !fs.existsSync(app)) {
	console.error("usage: check-app.mjs <path to .app> [--signed]");
	process.exit(2);
}
const runtime = path.join(app, "Contents", "Resources", "runtime");
const bin = path.join(app, "Contents", "MacOS", path.basename(app, ".app"));
const problems = [];
const ok = (msg) => console.log(`ok   ${msg}`);
const bad = (msg) => {
	problems.push(msg);
	console.error(`FAIL ${msg}`);
};

const mustExist = [
	"node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
	"node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
	"node_modules/onnxruntime-common/package.json",
	"node_modules/@huggingface/tokenizers/package.json",
	"embed-model/model.onnx",
	"embed-model/tokenizer.json",
	"embed-model/tokenizer_config.json",
];
for (const rel of mustExist) {
	const p = path.join(runtime, rel);
	if (!fs.existsSync(p)) bad(`missing ${rel}`);
	else if (rel.endsWith("model.onnx") && fs.statSync(p).size < 1e8) bad(`${rel} is too small`);
	else ok(rel);
}

// Every runtime bundle: the .mjs/.js files outside node_modules, prompts and agents.
const bundles = [];
const walk = (dir) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (!["node_modules", "prompts", "standards", "agents", "embed-model"].includes(e.name)) walk(p);
		} else if (/\.(mjs|js)$/.test(e.name)) bundles.push(p);
	}
};
walk(runtime);
if (bundles.length < 4) bad(`expected hubd, workerd, wolfd and the memory extension under runtime, found ${bundles.length} bundles`);

const probe = `
const { findPackageJSON } = require("node:module");
const [bundle, spec, runtime] = process.argv.slice(1);
let pj;
try { pj = findPackageJSON(spec, bundle); } catch (e) { console.log("ERR " + e.message.split("\\n")[0]); process.exit(1); }
if (!pj || !require("node:fs").realpathSync(pj).startsWith(require("node:fs").realpathSync(runtime) + "/")) { console.log("ERR resolves outside runtime: " + pj); process.exit(1); }
console.log(pj);
`;
for (const bundle of bundles) {
	const text = fs.readFileSync(bundle, "utf8");
	const rel = path.relative(runtime, bundle);
	for (const spec of REQUIRED_EXTERNALS) {
		if (!new RegExp(`["']${spec.replace(/[/@-]/g, (c) => `\\${c}`)}["']`).test(text)) continue;
		const r = spawnSync(bin, ["-e", probe, bundle, spec, runtime], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
		if (r.status === 0) ok(`${rel} imports ${spec} -> ${path.relative(runtime, r.stdout.trim())}`);
		else bad(`${rel} imports ${spec}, which does not resolve inside Resources/runtime (${(r.stdout || r.stderr).trim()})`);
	}
}

// The app is API-key only: the subscription bridge and the Agent SDK must not be in the packaged runtime.
if (fs.existsSync(path.join(runtime, "node_modules/@anthropic-ai/claude-agent-sdk"))) bad("runtime ships the Claude Agent SDK (the app is API-key only)");
// BRIDGE_MARKER is a string literal from the bridge's own code (stateless/errors.ts); minifiers keep string literals, and the build stub never contains it.
const BRIDGE_MARKER = "Claude request failed (fatal, do not retry)";
const SDK_IMPORT = /(?:from|import)\s*["']@anthropic-ai\/claude-agent-sdk["']/;
for (const bundle of bundles) {
	const text = fs.readFileSync(bundle, "utf8");
	const rel = path.relative(runtime, bundle);
	if (text.includes(BRIDGE_MARKER)) bad(`${rel} contains the Claude subscription bridge (the app is API-key only)`);
	// A static import of the SDK makes the bundle die at start when the SDK is not shipped.
	if (SDK_IMPORT.test(text)) bad(`${rel} has a static import of @anthropic-ai/claude-agent-sdk, which the app does not ship`);
}

// The onnx native must load under the app's own binary: proves library validation and @loader_path work (signed mode).
{
	const node = path.join(runtime, "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node");
	const r = spawnSync(bin, ["-e", "try { process.dlopen({ exports: {} }, process.argv[1]); console.log('loaded'); } catch (e) { console.log('ERR ' + e.message); process.exit(1); }", node], {
		encoding: "utf8",
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	if (r.status === 0) ok("onnxruntime_binding.node loads (dlopen)");
	else bad(`onnxruntime_binding.node does not load: ${(r.stdout || r.stderr).trim().slice(0, 400)}`);
}

if (signed) {
	for (const [label, cmd, a] of [
		["codesign", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]],
		["spctl", "spctl", ["-a", "-vv", app]],
		["stapler", "xcrun", ["stapler", "validate", app]],
	]) {
		const r = spawnSync(cmd, a, { encoding: "utf8" });
		if (r.status === 0) ok(label);
		else bad(`${label}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
	}
}

if (problems.length) {
	console.error(`check-app: ${problems.length} problem(s)`);
	process.exit(1);
}
console.log("check-app: all checks passed");
