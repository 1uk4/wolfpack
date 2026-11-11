/**
 * The hub's PUBLIC URL (what a phone or browser opens: https://<host>.ts.net/hub), read at RUNTIME.
 * NEXT_PUBLIC_* names are inlined by Next at build time when written as `process.env.NEXT_PUBLIC_X`, which would freeze a release tarball to
 * one host. The names are looked up through a variable here, so the inliner never sees them and the value comes from the unit's env file.
 * Order: WOLFPACK_HUB_PUBLIC_URL, HUBD_PUBLIC_URL (same name hubd uses for its QR codes), NEXT_PUBLIC_WOLFPACK_HUB_URL (legacy).
 */
const NAMES = ["WOLFPACK_HUB_PUBLIC_URL", "HUBD_PUBLIC_URL", "NEXT_PUBLIC_WOLFPACK_HUB_URL"];

export function hubPublicUrl(env: Record<string, string | undefined> = process.env): string | undefined {
	for (const n of NAMES) {
		const v = env[n]?.trim().replace(/\/+$/, "");
		if (v) return v;
	}
	return undefined;
}
