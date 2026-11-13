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
import { isHiddenInSingleMac, isSingleMac } from "@/src/core/single-mac";

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

export function proxy(req: NextRequest): NextResponse {
	// Single-Mac app: multi-machine features do not exist (work-wolfpack-TdmbaV4). API: 404; pages: home.
	if (isSingleMac() && isHiddenInSingleMac(req.nextUrl.pathname)) {
		if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "not found" }, { status: 404 });
		return NextResponse.redirect(new URL("/", req.url));
	}
	const headers = withCookieBearer(req.method, req.headers, isHttps(req));
	return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
