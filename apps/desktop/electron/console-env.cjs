/**
 * The environment of the console child when the app runs its own runtime (work-wolfpack-wOBXF9f).
 * An allowlist, not `...process.env`: a stray WOLFPACK_HUB_URL / WOLFPACK_HUB_TOKEN / WOLFPACK_HEALTH_* /
 * WOLFPACK_UPDATE_*_URL / ANTHROPIC_* / HTTPS_PROXY / GITHUB_TOKEN in the owner's shell must never steer the console
 * off this Mac. WOLFPACK_HUB_RELAY=0 keeps the console off the hub relay path even if a hub URL sneaks in via auth.json.
 * WOLFPACK_SINGLE_MAC=1 makes the console hide pairing, devices, pack health and the other multi-machine features (work-wolfpack-TdmbaV4).
 * Provider keys come from WOLFPACK_AUTH_FILE (the console reads it itself), not from the inherited env.
 */
const PASS = ["PATH", "HOME", "TMPDIR", "LANG"];

/** `extra` is what the caller adds on top (ports, data dir, auth file, workerd URLs); it is trusted. */
function consoleEnv(inherited, extra) {
	const out = {};
	for (const [k, v] of Object.entries(inherited)) if (v !== undefined && (PASS.includes(k) || k.startsWith("LC_"))) out[k] = v;
	return { ...out, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", HOSTNAME: "127.0.0.1", WOLFPACK_HUB_RELAY: "0", WOLFPACK_SINGLE_MAC: "1", ...extra };
}

module.exports = { consoleEnv };
