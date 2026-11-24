/**
 * Cookie -> bearer for read-only navigations (see the COOKIE MIRROR note in src/core/ui/hub-auth.ts for the rules). Runs before every page and
 * route; the rest of the server only ever reads `Authorization: Bearer`. It never touches a request that already has an Authorization
 * header, never acts on non-GET/HEAD, and never on a cross-site request that is not a top-level navigation.
 *
 * Which cookie NAME is read (`__Host-` on https) is decided by configuration, not by a header a client could send:
 *   1. WOLFPACK_CONSOLE_PUBLIC_ORIGIN (e.g. https://sfo-01.tailnet.ts.net): its scheme decides. Set this in production.
 *   2. unset: the RIGHTMOST X-Forwarded-Proto value (the one the nearest trusted proxy, e.g. `tailscale serve`, appended), else the request URL.
 *      A warning is logged once at startup, since a client-supplied header is then in play.
 */
import { NextResponse, type NextRequest } from "next/server";
import { withCookieBearer } from "@/src/core/ui/hub-auth";
import { packRedirectTarget } from "@/src/core/pack/pack-redirect";
import { isHiddenInSingleMac, isSingleMac, isUnavailableInSingleMac, singleMacBearer } from "@/src/core/single-mac";

let warned = false;
/** https as the browser saw it. `env` is injectable for tests. */
export const isHttps = (req: Pick<NextRequest, "headers" | "nextUrl">, env: Record<string, string | undefined> = process.env): boolean => {
	const origin = env.WOLFPACK_CONSOLE_PUBLIC_ORIGIN?.trim();
	if (origin) {
		try {
			return new URL(origin).protocol === "https:";
		} catch {
			throw new Error(`WOLFPACK_CONSOLE_PUBLIC_ORIGIN is not a URL: ${origin}`);
		}
	}
	if (!warned) {
		warned = true;
		console.warn("console: WOLFPACK_CONSOLE_PUBLIC_ORIGIN is not set; the cookie name follows X-Forwarded-Proto (rightmost value) or the request URL. Set it to the public origin (https://...) in production.");
	}
	const fwd = req.headers.get("x-forwarded-proto")?.split(",").pop()?.trim().toLowerCase();
	return fwd ? fwd === "https" : req.nextUrl.protocol === "https:";
};

/**
 * `?pack=<section>` on any page goes to /pack/<section> (work-wolfpack-oz3wvq3), keeping wolf, wolfTab and the original view. It runs here, before
 * any page renders, so a page viewer on the page you opened (e.g. /work restoring its saved view) cannot overwrite `view` first.
 * The target (src/core/pack/pack-redirect.ts) carries the origin page in `from`; the Pack page stores it as its close-button return path.
 * The Location must be ABSOLUTE: Next 16's middleware adapter parses it with `new NextURL`, and a relative one throws "Invalid URL" (500).
 * It names the origin the browser used, not the internal one behind a reverse proxy: WOLFPACK_CONSOLE_PUBLIC_ORIGIN, else the rightmost
 * X-Forwarded-Proto with X-Forwarded-Host (or Host), else the request's own origin. A forwarded host that is not a plain host[:port]
 * (slash, `@`, whitespace) is ignored, so a crafted header cannot produce an off-site redirect.
 */
const PLAIN_HOST = /^[A-Za-z0-9._-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;
function publicOrigin(req: NextRequest, env: Record<string, string | undefined> = process.env): string {
	const configured = env.WOLFPACK_CONSOLE_PUBLIC_ORIGIN?.trim();
	if (configured) {
		try {
			return new URL(configured).origin;
		} catch {
			throw new Error(`WOLFPACK_CONSOLE_PUBLIC_ORIGIN is not a URL: ${configured}`);
		}
	}
	const fwdProto = req.headers.get("x-forwarded-proto")?.split(",").pop()?.trim().toLowerCase();
	const proto = fwdProto === "http" || fwdProto === "https" ? fwdProto : req.nextUrl.protocol.replace(":", "");
	const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host"))?.split(",").pop()?.trim();
	// NextURL rewrites 127.0.0.1 to localhost, so the Host header is the better record of what the browser typed.
	if (host && PLAIN_HOST.test(host)) return `${proto}://${host}`;
	return req.nextUrl.origin;
}

function packRedirect(req: NextRequest): NextResponse | null {
	if (req.method !== "GET" && req.method !== "HEAD") return null;
	const to = packRedirectTarget(req.nextUrl.pathname, req.nextUrl.search);
	if (to === null) return null;
	return NextResponse.redirect(new URL(to, publicOrigin(req)), 307);
}

export function proxy(req: NextRequest): NextResponse {
	const packed = packRedirect(req);
	if (packed) return packed;
	// Single-Mac app: multi-machine features do not exist (work-wolfpack-TdmbaV4). API: 404; pages: home.
	if (isSingleMac() && isHiddenInSingleMac(req.nextUrl.pathname)) {
		if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "not found" }, { status: 404 });
		return NextResponse.redirect(new URL("/", req.url));
	}
	if (isSingleMac() && isUnavailableInSingleMac(req.nextUrl.pathname, req.method)) return NextResponse.json({ error: "not available on this Mac", code: "unsupported" }, { status: 501, headers: { "Cache-Control": "no-store" } });
	const injected = singleMacBearer({ method: req.method, pathname: req.nextUrl.pathname, headers: req.headers, urlHost: req.nextUrl.host });
	if (injected) return NextResponse.next({ request: { headers: injected } });
	const headers = withCookieBearer(req.method, req.headers, isHttps(req));
	return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
