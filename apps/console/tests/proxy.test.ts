/** proxy.ts: the cookie becomes a bearer only for read-only, non-cross-site requests without an Authorization header. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("single-Mac mode (WOLFPACK_SINGLE_MAC=1, work-wolfpack-TdmbaV4)", () => {
	const at = (path: string) => req("GET", {}, `http://127.0.0.1:3210${path}`);
	const withFlag = (value: string | undefined, fn: () => void) => {
		const before = process.env.WOLFPACK_SINGLE_MAC;
		if (value === undefined) delete process.env.WOLFPACK_SINGLE_MAC;
		else process.env.WOLFPACK_SINGLE_MAC = value;
		try {
			fn();
		} finally {
			if (before === undefined) delete process.env.WOLFPACK_SINGLE_MAC;
			else process.env.WOLFPACK_SINGLE_MAC = before;
		}
	};
	it("answers 404 on multi-machine API routes", () => {
		withFlag("1", () => {
			for (const p of ["/api/devices", "/api/devices/pairing-code", "/api/hub-url", "/api/updates", "/api/stt/token"]) assert.equal(proxy(at(p)).status, 404, p);
		});
	});
	it("keeps this Mac's own subscription route reachable (the own machine card reads it) while the rest of /api/health stays unavailable", () => {
		withFlag("1", () => {
			assert.equal(proxy(at("/api/health/subscription")).status, 200);
			assert.equal(proxy(at("/api/health/subscription/x")).status, 501);
		});
	});
	it("redirects the pairing page home", () => {
		withFlag("1", () => {
			const pair = proxy(at("/pair"));
			assert.equal(pair.status, 307);
			assert.equal(new URL(pair.headers.get("location") ?? "").pathname, "/");
		});
	});
	it("leaves chat, KB and the domains API (the setup wizard's Knowledge step) reachable", () => {
		withFlag("1", () => {
			for (const p of ["/", "/api/wolves", "/api/wolves/hal/kb/graph", "/api/pack/domains", "/api/healthy-sibling", "/graph", "/settings"]) assert.equal(proxy(at(p)).status, 200, p);
		});
	});
	it("injects the console's own hub token when the request has no Authorization, and leaves an explicit header alone", () => {
		const before = process.env.WOLFPACK_HUB_TOKEN;
		process.env.WOLFPACK_HUB_TOKEN = "console-tok";
		try {
			withFlag("1", () => {
				assert.equal(fwd(proxy(at("/api/pack/keys"))), "Bearer console-tok");
				assert.equal(fwd(proxy(req("POST", {}, "http://127.0.0.1:3210/api/pack/keys"))), "Bearer console-tok");
				assert.equal(fwd(proxy(req("GET", { authorization: "Bearer mine" }, "http://127.0.0.1:3210/api/pack/keys"))), null);
			});
			withFlag(undefined, () => assert.equal(fwd(proxy(at("/api/pack/keys"))), null)); // never outside single-Mac mode
		} finally {
			if (before === undefined) delete process.env.WOLFPACK_HUB_TOKEN;
			else process.env.WOLFPACK_HUB_TOKEN = before;
		}
	});
	const withToken = (fn: () => void) => {
		const before = process.env.WOLFPACK_HUB_TOKEN;
		process.env.WOLFPACK_HUB_TOKEN = "console-tok";
		try {
			withFlag("1", fn);
		} finally {
			if (before === undefined) delete process.env.WOLFPACK_HUB_TOKEN;
			else process.env.WOLFPACK_HUB_TOKEN = before;
		}
	};
	it("single-Mac injects only on /api/ paths from a loopback host", () => {
		withToken(() => {
			assert.equal(fwd(proxy(at("/"))), null);
			assert.equal(fwd(proxy(at("/_next/data/x.json"))), null);
			assert.equal(fwd(proxy(at("/wolf/hal"))), null);
			for (const host of ["127.0.0.1:3210", "localhost:3210", "[::1]:3210", "localhost"]) assert.equal(fwd(proxy(req("GET", { host }, "http://127.0.0.1:3210/api/pack/keys"))), "Bearer console-tok", host);
			for (const host of ["evil.example:3210", "127.0.0.1.evil.example", "attacker.test"]) assert.equal(fwd(proxy(req("GET", { host }, "http://127.0.0.1:3210/api/pack/keys"))), null, host);
		});
	});
	it("single-Mac skips injection for a cross-site POST (Sec-Fetch-Site: cross-site / foreign Origin)", () => {
		withToken(() => {
			const post = (headers: Record<string, string>) => fwd(proxy(req("POST", { host: "127.0.0.1:3210", ...headers }, "http://127.0.0.1:3210/api/pack/keys")));
			assert.equal(post({ "sec-fetch-site": "cross-site" }), null);
			assert.equal(post({ "sec-fetch-site": "same-site" }), null);
			assert.equal(post({ origin: "https://evil.example" }), null);
			assert.equal(post({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3210" }), "Bearer console-tok");
			assert.equal(post({ "sec-fetch-site": "none" }), "Bearer console-tok");
			assert.equal(post({}), "Bearer console-tok");
		});
	});
	it("answers 501 for a health action (restart, rollback, update, subscription) and passes GET /api/health, its stream and inventory", async () => {
		const answers: Array<[string, Response]> = [];
		const reads: Array<[string, number]> = [];
		withFlag("1", () => {
			for (const [m, p] of [["POST", "/api/health/restart"], ["POST", "/api/health/rollback"], ["POST", "/api/health/update"], ["GET", "/api/health/update"], ["PUT", "/api/health/subscription"]] as const) answers.push([`${m} ${p}`, proxy(req(m, {}, `http://127.0.0.1:3210${p}`))]);
			for (const p of ["/api/health", "/api/health/stream", "/api/health/inventory"]) reads.push([p, proxy(at(p)).status]);
		});
		for (const [what, res] of answers) {
			assert.equal(res.status, 501, what);
			assert.deepEqual(await res.json(), { error: "not available on this Mac", code: "unsupported" }, what);
		}
		for (const [p, status] of reads) assert.equal(status, 200, p);
	});
	it("every /api/health subroute is classified: open (health, stream, inventory) or answered 501", () => {
		const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "api", "health");
		const subs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "route.ts"))).map((d) => d.name).sort();
		assert.deepEqual(subs, ["inventory", "restart", "rollback", "stream", "subscription", "update"]); // a new route fails here until it is sorted into one of the two sets below
		withFlag("1", () => {
			for (const s of subs) assert.equal(proxy(at(`/api/health/${s}`)).status, ["inventory", "stream", "subscription"].includes(s) ? 200 : 501, s); // subscription: GET only (the own card reads it); its PUT is 501 above
		});
	});
	it("changes nothing with the flag unset", () => {
		withFlag(undefined, () => {
			for (const p of ["/api/devices", "/api/health", "/pair"]) assert.equal(proxy(at(p)).status, 200, p);
		});
	});
});
