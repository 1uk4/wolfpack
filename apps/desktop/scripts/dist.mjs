/**
 * dist.mjs — local macOS packaging, unsigned or signed.
 *
 *   node scripts/dist.mjs           unsigned dmg + zip (no identity, no notarization)
 *   node scripts/dist.mjs --signed  Developer ID signed + notarized + stapled
 *   node scripts/dist.mjs --sign-only  Developer ID signed with hardened runtime + entitlements, NOT notarized: a rehearsal before the first
 *                                   Apple upload. Identity preflight only (no notary profile, no APPLE_* env); no notarization upload
 *                                   (codesign still contacts timestamp.apple.com). check-app runs its --sign-only checks.
 *   node scripts/dist.mjs --check   preflight only (with --signed: cert + notary profile; with --sign-only: cert)
 *   node scripts/dist.mjs --ci      signed + notarized on a CI runner: credentials come from the environment
 *                                   (CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY = path to the .p8, APPLE_API_KEY_ID, APPLE_API_ISSUER),
 *                                   no keychain profile. Same steps as --signed; only the credential source differs.
 *
 * Every mode ends with scripts/check-app.mjs on the built .app (natives and model present, no Agent SDK or subscription bridge; every bare import of
 * the runtime bundles resolves inside Resources/runtime; signed modes also codesign/spctl/stapler). It never publishes:
 * the release job uploads afterwards with `electron-builder publish`.
 *
 * Both modes pick an Xcode >= 26 for actool (build/icon.icon needs it) by
 * setting DEVELOPER_DIR when the active developer dir is older.
 * Signed mode needs a "Developer ID Application" identity in the keychain
 * and a notarytool keychain profile (default name WOLFPACK_NOTARY, created
 * with `xcrun notarytool store-credentials WOLFPACK_NOTARY`). electron-builder
 * reads the profile from APPLE_KEYCHAIN_PROFILE; the other APPLE_* credential
 * vars take precedence over it, so they are removed from the child env.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { planBuild } from "./sign-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const ci = args.includes("--ci");
const checkOnly = args.includes("--check");
const profile = process.env.WOLFPACK_NOTARY_PROFILE || "WOLFPACK_NOTARY";

const fail = (msg) => {
	console.error(`dist: ${msg}`);
	process.exit(1);
};
const out = (cmd, a, env) => spawnSync(cmd, a, { encoding: "utf8", env: env ?? process.env });

function xcodeMajor(devDir) {
	const r = out("xcrun", ["actool", "--version"], { ...process.env, DEVELOPER_DIR: devDir });
	const m = /<string>(\d+)\./.exec(r.stdout ?? "");
	return m ? Number(m[1]) : 0;
}

/** DEVELOPER_DIR whose actool is >= 26, or fail. */
function developerDir() {
	const candidates = [];
	if (process.env.DEVELOPER_DIR) candidates.push(process.env.DEVELOPER_DIR);
	const active = out("xcode-select", ["-p"]).stdout?.trim();
	if (active) candidates.push(active);
	if (fs.existsSync("/Applications")) {
		for (const n of fs.readdirSync("/Applications").filter((f) => /^Xcode.*\.app$/.test(f)).sort().reverse()) candidates.push(`/Applications/${n}/Contents/Developer`);
	}
	for (const d of candidates) if (xcodeMajor(d) >= 26) return d;
	return fail("no Xcode 26+ found (actool >= 26 compiles build/icon.icon). Install Xcode 26 or set DEVELOPER_DIR.");
}

let env = { ...process.env, DEVELOPER_DIR: developerDir() };
let checkAppFlags = [];
console.log(`dist: DEVELOPER_DIR=${env.DEVELOPER_DIR}`);

let builderArgs = ["--mac", "--arm64", "--publish", "never"];
if (ci) {
	const missing = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"].filter((k) => !process.env[k]);
	if (missing.length) fail(`--ci needs ${missing.join(", ")} in the environment`);
	if (!fs.existsSync(process.env.APPLE_API_KEY)) fail("APPLE_API_KEY must be the path of the App Store Connect .p8 file");
	delete env.APPLE_KEYCHAIN_PROFILE;
	checkAppFlags = ["--signed"];
	builderArgs.push("-c.mac.notarize=true");
} else {
	// unsigned (default), --signed or --sign-only: the decision is pure, see sign-plan.mjs
	const plan = planBuild({
		args,
		env,
		profile,
		identities: out("security", ["find-identity", "-v", "-p", "codesigning"]).stdout ?? "",
		probeNotary: () => out("xcrun", ["notarytool", "history", "--keychain-profile", profile, "--output-format", "json"]).status === 0,
	});
	if (plan.error) fail(plan.error);
	builderArgs = plan.builderArgs;
	env = plan.env;
	checkAppFlags = plan.checkAppFlags;
}
if (checkOnly) {
	console.log("dist: preflight ok");
	process.exit(0);
}

const run = (cmd, a, cwd = root) => {
	const r = spawnSync(cmd, a, { cwd, stdio: "inherit", env });
	if (r.status !== 0) process.exit(r.status ?? 1);
};
// The runtime the app starts (work-wolfpack-07v3AmE): packages -> bundles -> onnx natives + embedding model. WOLFPACK_SKIP_RUNTIME=1 reuses apps/desktop/runtime as it is.
if (process.env.WOLFPACK_SKIP_RUNTIME !== "1") {
	run("pnpm", ["-r", "--filter", "./packages/*", "build"], path.resolve(root, "../.."));
	run(process.execPath, ["scripts/build-runtime.mjs"]);
	run(process.execPath, ["scripts/stage-runtime-assets.mjs"]);
} else {
	// Reusing runtime/ is only allowed when it is complete: the onnx binding, and the model.
	const need = [
		"node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
		"embed-model/model.onnx",
	].filter((f) => !fs.existsSync(path.join(root, "runtime", f)));
	if (need.length) fail(`WOLFPACK_SKIP_RUNTIME=1 but runtime/ lacks: ${need.join(", ")}. Run without it (or scripts/stage-runtime-assets.mjs).`);
}
run("pnpm", ["run", "build:server"]);
run("pnpm", ["exec", "electron-builder", ...builderArgs]);
run(process.execPath, ["scripts/check-app.mjs", path.join(root, "dist", "mac-arm64", "Wolfpack Console.app"), ...checkAppFlags]);
