/**
 * Cookie -> bearer for read-only navigations (see the COOKIE MIRROR note in src/core/hub-auth.ts for the rules). Runs before every page and
 * route; the rest of the server only ever reads `Authorization: Bearer`. It never touches a request that already has an Authorization
 * header, never acts on non-GET/HEAD, and never on a cross-site request that is not a top-level navigation.
 */
import { NextResponse, type NextRequest } from "next/server";
import { withCookieBearer } from "@/src/core/hub-auth";

/** https as the browser saw it: the reverse proxy's X-Forwarded-Proto (tailscale serve), else the request URL. */
export const isHttps = (req: Pick<NextRequest, "headers" | "nextUrl">): boolean => {
	const fwd = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
	return fwd ? fwd === "https" : req.nextUrl.protocol === "https:";
};

export function proxy(req: NextRequest): NextResponse {
	const headers = withCookieBearer(req.method, req.headers, isHttps(req));
	return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
