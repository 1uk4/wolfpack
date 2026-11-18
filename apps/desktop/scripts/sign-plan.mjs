/**
 * Pure decisions shared by dist.mjs and check-app.mjs (no keychain, no network), so they can be tested.
 */

const APPLE_VARS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_KEYCHAIN_PROFILE"];

/**
 * Mode selection for the non-CI modes of dist.mjs.
 * args: argv after the script name. identities: `security find-identity -v -p codesigning` output.
 * probeNotary(): true when the notarytool keychain profile works (only called for --signed).
 * Returns { error } or { builderArgs, env, checkAppFlags }.
 */
export function planBuild({ args, env, identities, probeNotary, profile }) {
	const signed = args.includes("--signed");
	const signOnly = args.includes("--sign-only");
	const builderArgs = ["--mac", "--arm64", "--publish", "never"];
	if (signed && signOnly) return { error: "--sign-only and --signed are exclusive: --sign-only never notarizes" };
	if (!signed && !signOnly) {
		builderArgs.push("-c.mac.identity=null", "-c.mac.notarize=false");
		return { builderArgs, env: { ...env }, checkAppFlags: [] };
	}
	if (!/"Developer ID Application:/.test(identities ?? "")) {
		return {
			error:
				'no "Developer ID Application" signing identity in the keychain (security find-identity -v -p codesigning). ' +
				"Install the Developer ID Application certificate, or use `pnpm --filter @wolfpack/desktop dist` for an unsigned build.",
		};
	}
	const childEnv = { ...env };
	for (const k of APPLE_VARS) delete childEnv[k];
	if (signOnly) {
		builderArgs.push("-c.mac.notarize=false");
		return { builderArgs, env: childEnv, checkAppFlags: ["--sign-only"] };
	}
	if (!probeNotary()) return { error: `notarytool keychain profile "${profile}" is missing or invalid. Create it: xcrun notarytool store-credentials ${profile}` };
	childEnv.APPLE_KEYCHAIN_PROFILE = profile;
	builderArgs.push("-c.mac.notarize=true");
	return { builderArgs, env: childEnv, checkAppFlags: ["--signed"] };
}

/** Facts from `codesign -dvv` output (it prints on stderr). */
export function parseSignature(text) {
	const authorities = [...text.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1]);
	const team = /^TeamIdentifier=(.*)$/m.exec(text)?.[1]?.trim();
	const flags = /flags=0x([0-9a-f]+)/i.exec(text)?.[1];
	return {
		developerId: authorities[0]?.startsWith("Developer ID Application") ?? false,
		hardenedRuntime: flags ? (parseInt(flags, 16) & 0x10000) !== 0 : false,
		team: team && team !== "not set" ? team : null,
	};
}

/** Entitlement dictionaries (parsed) equal regardless of key order. */
export function sameEntitlements(a, b) {
	const norm = (o) => JSON.stringify(Object.entries(o ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
	return norm(a) === norm(b);
}
