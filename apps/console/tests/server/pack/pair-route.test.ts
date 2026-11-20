/** /api/pair relays a typed pairing code to the hub; hubd's limiter sees only the console's socket, so the route limits each client itself. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { POST } from "../../../app/api/pair/route.ts";

const realFetch = globalThis.fetch;
let hubCalls = 0;
beforeEach(() => {
	process.env.WOLFPACK_HUB_URL = "http://hub.test";
	hubCalls = 0;
	globalThis.fetch = (async () => {
		hubCalls++;
		return new Response(JSON.stringify({ token: "t" }), { status: 200 });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.WOLFPACK_HUB_URL;
});

const attempt = (ip: string, contentType = "application/json"): Promise<Response> =>
	POST(
		new Request("http://console/api/pair", {
			method: "POST",
			headers: { "content-type": contentType, "x-forwarded-for": `${ip}, 10.0.0.1` },
			body: JSON.stringify({ code: "ABCD", label: "phone" }),
		}),
	);

describe("pair route", () => {
	it("answers 429 rate_limited with Retry-After after 10 attempts from one client, without touching other clients", async () => {
		for (let i = 0; i < 10; i++) assert.equal((await attempt("203.0.113.7")).status, 200);
		const blocked = await attempt("203.0.113.7");
		assert.equal(blocked.status, 429);
		assert.equal(Number(blocked.headers.get("retry-after")) > 0, true);
		assert.equal(((await blocked.json()) as { code: string }).code, "rate_limited");
		assert.equal(hubCalls, 10);
		assert.equal((await attempt("203.0.113.8")).status, 200);
	});

	it("rejects a non-JSON content type with 415 before calling the hub", async () => {
		const res = await attempt("203.0.113.9", "text/plain");
		assert.equal(res.status, 415);
		assert.equal(hubCalls, 0);
	});
});
