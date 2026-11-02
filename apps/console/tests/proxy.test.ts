/** proxy.ts: the cookie becomes a bearer only for read-only, non-cross-site requests without an Authorization header. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy, isHttps } from "../proxy.ts";

const fwd = (res: Response) => res.headers.get("x-middleware-request-authorization");
const req = (method: string, headers: Record<string, string>, url = "http://127.0.0.1:3210/wolf/hal2") => new NextRequest(url, { method, headers });

describe("proxy cookie -> bearer", () => {
	it("GET with the cookie forwards a bearer", () => assert.equal(fwd(proxy(req("GET", { cookie: "wolfpack_hub_token=tok-1" }))), "Bearer tok-1"));
	it("POST with the cookie forwards nothing", () => assert.equal(fwd(proxy(req("POST", { cookie: "wolfpack_hub_token=tok-1" }))), null));
	it("an existing Authorization header is left alone", () => assert.equal(fwd(proxy(req("GET", { authorization: "Bearer nope", cookie: "wolfpack_hub_token=tok-1" }))), null));
	it("cross-site fetch is not cookie-authenticated", () => assert.equal(fwd(proxy(req("GET", { cookie: "wolfpack_hub_token=tok-1", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }))), null));
	it("https is read from X-Forwarded-Proto (tailscale serve) and then needs the __Host- cookie", () => {
		const h = { "x-forwarded-proto": "https" };
		assert.equal(isHttps(req("GET", h)), true);
		assert.equal(fwd(proxy(req("GET", { ...h, cookie: "wolfpack_hub_token=tok-1" }))), null);
		assert.equal(fwd(proxy(req("GET", { ...h, cookie: "__Host-wolfpack_hub_token=tok-2" }))), "Bearer tok-2");
	});
	it("WOLFPACK_CONSOLE_PUBLIC_ORIGIN decides over X-Forwarded-Proto (a client-sent header cannot flip the cookie name)", () => {
		const r = req("GET", { "x-forwarded-proto": "https" });
		assert.equal(isHttps(r, { WOLFPACK_CONSOLE_PUBLIC_ORIGIN: "http://localhost:3210" }), false);
		assert.equal(isHttps(req("GET", {}), { WOLFPACK_CONSOLE_PUBLIC_ORIGIN: "https://x.ts.net" }), true);
		assert.throws(() => isHttps(r, { WOLFPACK_CONSOLE_PUBLIC_ORIGIN: "nonsense" }));
	});
	it("without config the RIGHTMOST X-Forwarded-Proto wins", () => {
		assert.equal(isHttps(req("GET", { "x-forwarded-proto": "https, http" }), {}), false);
		assert.equal(isHttps(req("GET", { "x-forwarded-proto": "http, https" }), {}), true);
	});
});
