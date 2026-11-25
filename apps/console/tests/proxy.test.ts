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

describe("?pack= redirect (work-wolfpack-oz3wvq3)", () => {
	const at = (path: string) => req("GET", {}, `http://127.0.0.1:3210${path}`);
	const where = (res: Response) => {
		const u = new URL(res.headers.get("location") ?? "http://none/", "http://base.invalid");
		return u.pathname + u.search;
	};
	it("on /work with ?pack=wolves goes to /pack/wolves before any page mounts, keeping wolf and the original view", () => {
		const res = proxy(at("/work?pack=wolves&wolf=sfo-01-wolves%2Fhal&view=prompt%3Asystem.ending-turn"));
		assert.equal(res.status, 307);
		assert.equal(where(res), "/pack/wolves/sfo-01-wolves/hal/prompts?view=prompt%3Asystem.ending-turn&from=%2Fwork");
	});
	it("an unknown section goes to machines, and a page without ?pack= is left alone", () => {
		assert.equal(where(proxy(at("/?pack=nope"))), "/pack/machines?from=%2F");
		assert.equal(proxy(at("/work?view=prompt%3Ax")).status, 200);
	});
	it("carries the origin page in from, so the Pack's close button returns to it", () => {
		assert.equal(where(proxy(at("/work?x=1&pack=keys"))), "/pack/keys?from=%2Fwork%3Fx%3D1");
	});
	// Next 16's middleware adapter parses a response Location as an absolute URL; a relative one throws "Invalid URL" (500).
	const absolute = (res: Response) => {
		const loc = res.headers.get("location") ?? "";
		assert.doesNotThrow(() => new URL(loc), `Location must be absolute: ${loc}`);
		return loc;
	};
	const withPublicOrigin = (value: string | undefined, fn: () => void) => {
		const before = process.env.WOLFPACK_CONSOLE_PUBLIC_ORIGIN;
		if (value === undefined) delete process.env.WOLFPACK_CONSOLE_PUBLIC_ORIGIN;
		else process.env.WOLFPACK_CONSOLE_PUBLIC_ORIGIN = value;
		try {
			fn();
		} finally {
			if (before === undefined) delete process.env.WOLFPACK_CONSOLE_PUBLIC_ORIGIN;
			else process.env.WOLFPACK_CONSOLE_PUBLIC_ORIGIN = before;
		}
	};
	it("names the configured public origin in an absolute Location, keeping the path, from and kept params", () => {
		withPublicOrigin("https://sfo-01.example.ts.net", () => {
			const loc = absolute(proxy(req("GET", { host: "internal:3210" }, "http://localhost:3210/work?pack=wolves&wolf=sfo-01-wolves%2Fhal&view=prompt%3Ax")));
			assert.equal(loc, "https://sfo-01.example.ts.net/pack/wolves/sfo-01-wolves/hal/prompts?view=prompt%3Ax&from=%2Fwork");
		});
	});
	it("without config uses the rightmost X-Forwarded-Proto and the forwarded host", () => {
		withPublicOrigin(undefined, () => {
			const res = proxy(req("GET", { "x-forwarded-proto": "http, https", "x-forwarded-host": "public.example" }, "http://localhost:3210/work?pack=keys"));
			assert.equal(absolute(res), "https://public.example/pack/keys?from=%2Fwork");
		});
	});
	it("with no config and no forwarding headers uses the request's own origin", () => {
		withPublicOrigin(undefined, () => {
			assert.equal(absolute(proxy(req("GET", {}, "http://localhost:3210/work?pack=keys"))), "http://localhost:3210/pack/keys?from=%2Fwork");
		});
	});
	it("ignores a forwarded host that is not a plain host[:port], so a crafted header cannot redirect off-site", () => {
		withPublicOrigin(undefined, () => {
			for (const bad of ["evil.com/x", "a@b", "a b"]) {
				const res = proxy(req("GET", { "x-forwarded-proto": "https", "x-forwarded-host": bad }, "http://localhost:3210/work?pack=keys"));
				assert.equal(absolute(res), "http://localhost:3210/pack/keys?from=%2Fwork", bad);
			}
		});
	});
	it("leaves alone a POST, the API, the Pack itself, /pair and a static asset", () => {
		assert.equal(proxy(req("POST", {}, "http://127.0.0.1:3210/work?pack=keys")).status, 200);
		for (const p of ["/api/x?pack=keys", "/pack/keys?pack=wolves", "/pair?pack=keys", "/logo.png?pack=keys"]) assert.equal(proxy(at(p)).status, 200, p);
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
