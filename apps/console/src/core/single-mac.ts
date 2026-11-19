/**
 * Single-Mac mode (work-wolfpack-TdmbaV4): the desktop app runs the whole pack on one Mac and sets WOLFPACK_SINGLE_MAC=1 for its console.
 * Everything that only makes sense for a multi-machine pack is hidden: its routes answer 404 (API) or go home (pages), and the UI drops
 * its entries. With the flag unset nothing here has any effect. This file is the one place that knows the list.
 */
export const isSingleMac = (env: Record<string, string | undefined> = process.env): boolean => env.WOLFPACK_SINGLE_MAC === "1";

/** Path prefixes (page or API) of hidden features. Matches the prefix itself and anything below it, never a longer sibling name. */
export const SINGLE_MAC_HIDDEN_PREFIXES = [
	"/pair", // pairing a browser or phone to a hub
	"/api/devices", // paired devices
	"/api/hub-url", // the hub's public address for pairing
	"/api/updates", // pack component update notices
	"/api/stt", // voice dictation token (Deepgram)
] as const;

/** Health actions that need other machines or a release pipeline: GET /api/health, /stream and /inventory stay, these answer 501. */
const UNAVAILABLE_PREFIXES = ["/api/health/restart", "/api/health/rollback", "/api/health/update", "/api/health/subscription"] as const;

/** The own machine card reads this Mac's release channel and update mode (work-wolfpack-AAEtByQ): GET/HEAD on the exact subscription path stay open; writes answer 501. */
export function isUnavailableInSingleMac(pathname: string, method = "POST"): boolean {
	if (pathname === "/api/health/subscription" && (method === "GET" || method === "HEAD")) return false;
	return UNAVAILABLE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const isLoopbackHost = (host: string | null): boolean => host !== null && LOOPBACK_HOST.test(host.trim());
const isLoopbackOrigin = (origin: string): boolean => {
	try {
		return isLoopbackHost(new URL(origin).host);
	} catch {
		return false; // "null" and other opaque origins
	}
};

/**
 * This app's console is loopback-only and a pack of one Mac: a request without an Authorization header carries the console's own hub
 * token (WOLFPACK_HUB_TOKEN, set by the app). Undefined when the flag or token is unset, or the request already has a header.
 */
export function singleMacBearer(req: { method: string; pathname: string; headers: Headers; urlHost?: string }, env: Record<string, string | undefined> = process.env): Headers | undefined {
	const { headers } = req;
	const token = env.WOLFPACK_HUB_TOKEN?.trim();
	if (!isSingleMac(env) || !token || headers.has("authorization")) return undefined;
	// Only API calls, only addressed to a loopback host (a DNS-rebound page arrives with a foreign Host), and for anything that can change
	// state only from this app itself (never a cross-site request, which browsers label with Sec-Fetch-Site and/or a foreign Origin).
	if (!req.pathname.startsWith("/api/") || !isLoopbackHost(headers.get("host") ?? req.urlHost ?? null)) return undefined;
	if (req.method !== "GET" && req.method !== "HEAD") {
		const site = headers.get("sec-fetch-site");
		if (site && site !== "same-origin" && site !== "none") return undefined;
		const origin = headers.get("origin");
		if (origin !== null && !isLoopbackOrigin(origin)) return undefined;
	}
	const out = new Headers(headers);
	out.set("authorization", `Bearer ${token}`);
	return out;
}

export function isHiddenInSingleMac(pathname: string): boolean {
	return SINGLE_MAC_HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
