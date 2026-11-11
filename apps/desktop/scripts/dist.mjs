/**
 * dist.mjs — local macOS packaging, unsigned or signed.
 *
 *   node scripts/dist.mjs           unsigned dmg + zip (no identity, no notarization)
 *   node scripts/dist.mjs --signed  Developer ID signed + notarized + stapled
 *   node scripts/dist.mjs --check   preflight only (with --signed: cert + notary profile)
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const signed = args.includes("--signed");
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

const env = { ...process.env, DEVELOPER_DIR: developerDir() };
console.log(`dist: DEVELOPER_DIR=${env.DEVELOPER_DIR}`);

const builderArgs = ["--mac", "--arm64", "--publish", "never"];
if (signed) {
	const ids = out("security", ["find-identity", "-v", "-p", "codesigning"]).stdout ?? "";
	if (!/"Developer ID Application:/.test(ids)) {
		fail(
			'no "Developer ID Application" signing identity in the keychain (security find-identity -v -p codesigning). ' +
				"Install the Developer ID Application certificate, or use `pnpm --filter @wolfpack/desktop dist` for an unsigned build.",
		);
	}
	const probe = out("xcrun", ["notarytool", "history", "--keychain-profile", profile, "--output-format", "json"]);
	if (probe.status !== 0) {
		fail(`notarytool keychain profile "${profile}" is missing or invalid. Create it: xcrun notarytool store-credentials ${profile}`);
	}
	for (const k of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) delete env[k];
	env.APPLE_KEYCHAIN_PROFILE = profile;
	builderArgs.push("-c.mac.notarize=true");
} else {
	builderArgs.push("-c.mac.identity=null", "-c.mac.notarize=false");
}
if (checkOnly) {
	console.log("dist: preflight ok");
	process.exit(0);
}

const run = (cmd, a) => {
	const r = spawnSync(cmd, a, { cwd: root, stdio: "inherit", env });
	if (r.status !== 0) process.exit(r.status ?? 1);
};
run("pnpm", ["run", "build:server"]);
run("pnpm", ["exec", "electron-builder", ...builderArgs]);
