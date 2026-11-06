/**
 * BROWSER-SIDE HUB SIGN-IN (pure; the window/storage are injected so it tests without a DOM).
 *
 * The hub is called from the console's SERVER (route handlers), never from the browser. So the browser keeps its per-device hub token
 * in localStorage and attaches it as `Authorization: Bearer` to every same-origin `/api/` request; the console's server reads that
 * header per request and uses it for the hub calls (server/console-client.ts). A 401 from `/api/` means the token is missing, revoked or
 * wrong: clear it and go back to /pair.
 *
 * Pairing hands the token over in a URL FRAGMENT (`/pair#token=...`, from the hub's /pair page): fragments are never sent to a server
 * or logged; the console's /pair page reads it with `tokenFromHash`, stores it, then strips it from the address bar.
 *
 * Only a HUB-AUTH 401 signs the browser out: the console's server marks those with `X-Wolfpack-Hub-Auth: required`. Any other 401
 * under /api/ (a wolf host, anything else) keeps the token. And the token is cleared only if it is still the one that request sent, so a
 * slow in-flight request cannot wipe a freshly paired token.
 */

export const HUB_TOKEN_KEY = "wolfpack.hub.token";
export const PAIR_PATH = "/pair";
/** Set (to `required`) on the console server's 401s that come from hub authentication. */
export const HUB_AUTH_HEADER = "X-Wolfpack-Hub-Auth";

export interface TokenStorage {
	getItem(k: string): string | null;
	setItem(k: string, v: string): void;
	removeItem(k: string): void;
}

export const readHubToken = (s: TokenStorage): string | undefined => {
	try {
		return s.getItem(HUB_TOKEN_KEY)?.trim() || undefined;
	} catch {
		return undefined;
	}
};
/**
 * COOKIE MIRROR (read-only auth for server-rendered navigations).
 *
 * Page navigations (/wolf/<name>, thread pages) cannot carry an Authorization header, so the paired token is mirrored into a cookie that
 * the proxy (apps/console/proxy.ts) turns into a bearer for the server, UNDER THESE RULES (they exist because cookies, unlike the header,
 * are sent ambiently, and a tailnet host name is a public suffix: sibling services on the same host share the cookie jar, ports included):
 *   - only GET/HEAD requests are cookie-authenticated; every state-changing request needs the Authorization bearer (cookie ignored);
 *   - a request that already has an Authorization header is never cookie-authenticated (a bad bearer is a 401, not a fallback);
 *   - if Sec-Fetch-Site is present it must be same-origin or none (a cross-site top-level navigation, e.g. a link opened from Telegram, is
 *     allowed: it is a side-effect-free GET whose response the other site cannot read);
 *   - on https the cookie is `__Host-` prefixed (Secure, Path=/, no Domain: a sibling cannot overwrite it) and ONLY that name is read; on
 *     http (harness, localhost) the plain name. A name that appears twice is rejected, never "first wins";
 *   - the value must look like a token. SameSite=Lax so links from chat apps arrive signed in; this is safe because no GET has side effects.
 * hubd itself never authenticates from a cookie (relay.ts drops it; pinned by a hubd test).
 */
export const HUB_COOKIE = "wolfpack_hub_token";
export const HUB_COOKIE_HOST = "__Host-wolfpack_hub_token";
export const HUB_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
export const hubCookieName = (https: boolean): string => (https ? HUB_COOKIE_HOST : HUB_COOKIE);
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{1,512}$/;

/** The Set-Cookie string that mirrors `token` (https: __Host- prefix + Secure). */
export function buildHubCookie(token: string, https: boolean): string {
	return `${hubCookieName(https)}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${HUB_COOKIE_MAX_AGE_S}${https ? "; Secure" : ""}`;
}
/** Set-Cookie strings that remove the mirror (also the plain legacy name, which an earlier build set on https origins too). */
export function clearHubCookies(https: boolean): string[] {
	const clear = (name: string, secure: boolean) => `${name}=; Path=/; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
	return https ? [clear(HUB_COOKIE_HOST, true), clear(HUB_COOKIE, false)] : [clear(HUB_COOKIE, false)];
}
/** The token in a Cookie request header for this protocol: undefined if absent, duplicated or not token-shaped. */
export function cookieTokenOf(header: string | null | undefined, https: boolean): string | undefined {
	const want = hubCookieName(https);
	const found: string[] = [];
	for (const part of (header ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i).trim() === want) found.push(part.slice(i + 1).trim());
	}
	if (found.length !== 1) return undefined;
	let v: string;
	try {
		v = decodeURIComponent(found[0]!);
	} catch {
		return undefined;
	}
	return TOKEN_SHAPE.test(v) ? v : undefined;
}
/** May a cookie stand in for the bearer on this request? GET/HEAD only, and a present Sec-Fetch-Site must be same-origin/none (or a top-level navigation). */
export function cookieAuthAllowed(method: string, headers: { get(name: string): string | null }): boolean {
	const m = method.toUpperCase();
	if (m !== "GET" && m !== "HEAD") return false;
	const site = headers.get("sec-fetch-site");
	if (site === null || site === "same-origin" || site === "none") return true;
	return headers.get("sec-fetch-mode") === "navigate" && headers.get("sec-fetch-dest") === "document";
}
/**
 * The request headers with `Authorization: Bearer <cookie token>` added, or undefined when the request is not (or may not be)
 * cookie-authenticated. Used by the proxy; downstream code (makeRequestToken) only ever reads the bearer.
 */
export function withCookieBearer(method: string, headers: Headers, https: boolean): Headers | undefined {
	if (headers.has("authorization")) return undefined; // an explicit (even wrong) bearer is final
	if (!cookieAuthAllowed(method, headers)) return undefined;
	const token = cookieTokenOf(headers.get("cookie"), https);
	if (!token) return undefined;
	const out = new Headers(headers);
	out.set("authorization", `Bearer ${token}`);
	return out;
}

/** Browser only: mirror (or, with undefined, clear) the token cookie. */
const writeCookie = (token: string | undefined): void => {
	if (typeof document === "undefined") return;
	const https = typeof location !== "undefined" && location.protocol === "https:";
	for (const c of token ? [buildHubCookie(token, https)] : clearHubCookies(https)) document.cookie = c;
};
/** Re-mirror the stored token into the cookie (app load: refreshes Max-Age, upgrades browsers paired before the cookie existed); no stored token clears it. */
export const syncHubCookie = (s: TokenStorage): void => writeCookie(readHubToken(s));
export const saveHubToken = (s: TokenStorage, token: string): void => {
	s.setItem(HUB_TOKEN_KEY, token);
	writeCookie(token);
};
export const clearHubToken = (s: TokenStorage): void => {
	writeCookie(undefined);
	try {
		s.removeItem(HUB_TOKEN_KEY);
	} catch {
		/* storage unavailable: nothing to clear */
	}
};

/** The token in a `#token=...` fragment, if any. */
export function tokenFromHash(hash: string): string | undefined {
	const t = new URLSearchParams(hash.replace(/^#/, "")).get("token")?.trim();
	return t || undefined;
}

type FetchFn = typeof fetch;

/**
 * `base` wrapped so same-origin `/api/` requests carry the stored token (an explicit Authorization is left alone) and a 401 from them
 * clears the token and calls `onUnauthorized` (the page navigates to /pair). `origin` is the page's own origin.
 */
export function withHubAuth(base: FetchFn, o: { storage: TokenStorage; origin: string; onUnauthorized: () => void }): FetchFn {
	return async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, o.origin);
		if (url.origin !== o.origin || !url.pathname.startsWith("/api/")) return base(input, init);
		const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
		const token = readHubToken(o.storage);
		if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
		const sent = bearerOf(headers.get("Authorization"));
		const res = await base(input, { ...init, headers });
		if (res.status === 401 && res.headers.get(HUB_AUTH_HEADER)?.toLowerCase() === "required" && readHubToken(o.storage) === sent) {
			clearHubToken(o.storage);
			o.onUnauthorized();
		}
		return res;
	};
}

/** Pull `Bearer <token>` out of an Authorization header value. */
export function bearerOf(header: string | null | undefined): string | undefined {
	const m = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
	return m?.[1];
}
