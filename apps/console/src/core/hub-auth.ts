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
export const saveHubToken = (s: TokenStorage, token: string): void => s.setItem(HUB_TOKEN_KEY, token);
export const clearHubToken = (s: TokenStorage): void => {
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
