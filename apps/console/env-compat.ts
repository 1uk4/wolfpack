/**
 * Env-var read with a legacy fallback. The product's env vars were renamed
 * LH_* → WOLFPACK_*; a running stack (Mac launchd, the sfo-01 console's
 * /etc/wolfpack/console.env) may still export the old name, so the new name
 * wins and the old one is honoured as a fallback.
 * legacy LH_ name, remove after 2026-12-05.
 */
export function readEnv(name: string, legacyName?: string): string | undefined {
	const v = process.env[name];
	if (v) return v;
	// legacy LH_ name, remove after 2026-12-05
	const old = legacyName ? process.env[legacyName] : undefined;
	return old || undefined;
}
