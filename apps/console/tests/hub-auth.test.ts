/** Hub sign-in: stored token -> bearer on /api, 401 -> token cleared; the console server prefers the forwarded token over the env one. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { bearerOf, buildHubCookie, clearHubCookies, cookieAuthAllowed, cookieTokenOf, HUB_COOKIE, HUB_COOKIE_HOST, syncHubCookie, withCookieBearer, clearHubToken, HUB_AUTH_HEADER, HUB_TOKEN_KEY, readHubToken, saveHubToken, tokenFromHash, tokenFromPairingInput, withHubAuth, type TokenStorage } from "../src/core/hub-auth.ts";
import { createMemoryApi } from "../src/server/memory-api.ts";
import { createConsoleClient, makeRequestToken, nextRequestToken } from "../src/server/console-client.ts";

const mem = (): TokenStorage & { m: Map<string, string> } => {
	const m = new Map<string, string>();
	return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const ORIGIN = "http://console.local";

describe("withHubAuth", () => {
	it("sends the stored token as a bearer on same-origin /api requests only", async () => {
		const storage = mem();
		saveHubToken(storage, "tok");
		const seen: (string | null)[] = [];
		const f = withHubAuth((async (_i: unknown, init?: RequestInit) => (seen.push(new Headers(init?.headers).get("authorization")), new Response("{}"))) as typeof fetch, {
			storage, origin: ORIGIN, onUnauthorized: () => assert.fail("no 401"),
		});
		await f("/api/needs-you");
		await f(`${ORIGIN}/api/x`, { headers: { Authorization: "Bearer explicit" } });
		await f("/not-api");
		await f("http://other.example/api/x");
		assert.deepEqual(seen, ["Bearer tok", "Bearer explicit", null, null]);
	});
	it("sends nothing without a token", async () => {
		let auth: string | null = "unset";
		const f = withHubAuth((async (_i: unknown, init?: RequestInit) => ((auth = new Headers(init?.headers).get("authorization")), new Response("{}"))) as typeof fetch, { storage: mem(), origin: ORIGIN, onUnauthorized: () => {} });
		await f("/api/a");
		assert.equal(auth, null);
	});
	const hub401 = () => new Response("{}", { status: 401, headers: { [HUB_AUTH_HEADER]: "required" } });
	it("a hub-auth 401 from /api clears the token and signals sign-in", async () => {
		const storage = mem();
		saveHubToken(storage, "tok");
		let called = 0;
		const f = withHubAuth((async () => hub401()) as typeof fetch, { storage, origin: ORIGIN, onUnauthorized: () => called++ });
		assert.equal((await f("/api/a")).status, 401);
		assert.equal(readHubToken(storage), undefined);
		assert.equal(storage.m.has(HUB_TOKEN_KEY), false);
		assert.equal(called, 1);
	});
	it("a 401 without the hub-auth marker keeps the token", async () => {
		const storage = mem();
		saveHubToken(storage, "tok");
		const f = withHubAuth((async () => new Response("{}", { status: 401 })) as typeof fetch, { storage, origin: ORIGIN, onUnauthorized: () => assert.fail("not a hub 401") });
		await f("/api/a");
		assert.equal(readHubToken(storage), "tok");
	});
	it("a stale-token 401 arriving after re-pairing keeps the new token", async () => {
		const storage = mem();
		saveHubToken(storage, "old");
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const f = withHubAuth((async () => (await gate, hub401())) as typeof fetch, { storage, origin: ORIGIN, onUnauthorized: () => assert.fail("stale") });
		const pending = f("/api/a"); // sent with "old"
		saveHubToken(storage, "new"); // re-paired meanwhile
		release();
		await pending;
		assert.equal(readHubToken(storage), "new");
	});
	it("tokenFromPairingInput takes a raw token or the token after #token= in a pairing link, nothing else", () => {
		assert.equal(tokenFromPairingInput("  abc123_-.~  "), "abc123_-.~");
		assert.equal(tokenFromPairingInput("http://127.0.0.1:3231/pair#token=abc123"), "abc123");
		assert.equal(tokenFromPairingInput("https://c.example/pair#x=1&token=a%2Bb&y=2"), "a+b");
		assert.equal(tokenFromPairingInput("#token=abc123"), "abc123");
		assert.equal(tokenFromPairingInput("http://127.0.0.1:3231/pair"), undefined, "a link without a token");
		assert.equal(tokenFromPairingInput("http://x/pair#token="), undefined);
		assert.equal(tokenFromPairingInput("not a token!"), undefined, "spaces and punctuation");
		assert.equal(tokenFromPairingInput("   "), undefined);
		assert.equal(tokenFromPairingInput(""), undefined);
	});
	it("helpers: fragment token, bearer parsing, clear", () => {
		assert.equal(tokenFromHash("#token=a%2Bb"), "a+b");
		assert.equal(tokenFromHash("#x=1"), undefined);
		assert.equal(bearerOf("Bearer abc"), "abc");
		assert.equal(bearerOf("Basic abc"), undefined);
		const s = mem();
		saveHubToken(s, "t");
		clearHubToken(s);
		assert.equal(readHubToken(s), undefined);
	});
});

describe("server: forwarded token", () => {
	const startHub = async () => {
		const seen: (string | undefined)[] = [];
		const hub = createServer((req, res) => {
			seen.push(req.headers.authorization);
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ items: [] }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		return { hub, seen, url: `http://127.0.0.1:${(hub.address() as AddressInfo).port}` };
	};
	it("uses the forwarded token; no token in a request scope rejects as hub-auth and never reaches the hub", async () => {
		const { hub, seen, url } = await startHub();
		try {
			let fwd: string | null | undefined = "browser";
			const c = createConsoleClient({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "env" }, async () => fwd);
			await c.listWork!("w", { domain: "d" });
			fwd = null;
			await assert.rejects(c.listWork!("w", { domain: "d" }), (e: Error & { code?: string; hubAuth?: boolean }) => e.name === "ProtocolError" && e.code === "unauthorized" && e.hubAuth === true);
			await assert.rejects(c.getWorkRecord!("w", "id"), /not paired/);
			assert.deepEqual(seen, ["Bearer browser"]);
		} finally {
			hub.close();
		}
	});
	it("with no request scope at all there is NO env fallback: 401, nothing reaches the hub", async () => {
		const { hub, seen, url } = await startHub();
		try {
			const c = createConsoleClient({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "env" }, async () => undefined);
			await assert.rejects(c.listWork!("w", { domain: "d" }), (e: Error & { hubAuth?: boolean }) => e.hubAuth === true);
			assert.deepEqual(seen, []);
		} finally {
			hub.close();
		}
	});
	it("the route handler answers an unpaired request 401 with the hub-auth marker (not 500)", async () => {
		const { hub, url } = await startHub();
		try {
			const c = createConsoleClient({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "env" }, async () => null);
			const res = await createMemoryApi(() => c).workList("w", "d", false);
			assert.equal(res.status, 401);
			assert.equal(res.headers.get(HUB_AUTH_HEADER), "required");
		} finally {
			hub.close();
		}
	});
	for (const [label, body] of [["a valid envelope", JSON.stringify({ code: "unauthorized", message: "missing or invalid bearer token", retryable: false })], ["a bare non-envelope body", "nope"], ["an empty body", ""]] as const) {
		it(`a hub 401 with ${label} reaches the route as 401 + marker (not 5xx) for listWork and getWorkRecord`, async () => {
			const hub = createServer((_req, res) => {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(body);
			});
			await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
			try {
				const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
				const c = createConsoleClient({ WOLFPACK_HUB_URL: url }, async () => "revoked");
				const api = createMemoryApi(() => c);
				for (const res of [await api.workList("w", "d", false), await api.workRecord("w", "id")]) {
					assert.equal(res.status, 401);
					assert.equal(res.headers.get(HUB_AUTH_HEADER), "required");
				}
			} finally {
				hub.close();
			}
		});
	}
});

describe("request token fails closed", () => {
	const h = (auth?: string) => async () => new Headers(auth ? { authorization: auth } : {});
	it("header -> token; request without header -> null", async () => {
		assert.equal(await makeRequestToken(h("Bearer abc"))(), "abc");
		assert.equal(await makeRequestToken(h())(), null);
	});
	it("only the outside-a-request error means no scope (undefined); any other failure is null", async () => {
		const outside = async (): Promise<Headers> => {
			throw new Error("`headers` was called outside a request scope. Read more: x");
		};
		const other = async (): Promise<Headers> => {
			throw new Error("something else broke");
		};
		assert.equal(await makeRequestToken(outside)(), undefined);
		assert.equal(await makeRequestToken(other)(), null);
	});
	it("real next/headers outside a request is undefined", async () => {
		assert.equal(await nextRequestToken(), undefined);
	});
});

// ---- cookie mirror: read-only navigations only (see the COOKIE MIRROR note in src/core/hub-auth.ts) ----
const CK = `${HUB_COOKIE}=tok-123`;
/** What the server sees for a request: the proxy's header rewrite, then makeRequestToken (bearer only). */
const serverToken = async (method: string, h: Record<string, string>, https = false) => {
	const headers = new Headers(h);
	return makeRequestToken(async () => withCookieBearer(method, headers, https) ?? headers)();
};

describe("cookie auth is read-only", () => {
	it("a POST (or any non-GET/HEAD) with only the cookie is unauthenticated (-> 401)", async () => {
		for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(await serverToken(m, { cookie: CK }), null, m);
	});
	it("a POST with the bearer works, and the cookie is ignored there", async () => {
		assert.equal(await serverToken("POST", { authorization: "Bearer abc", cookie: CK }), "abc");
	});
	it("a GET/HEAD with only the cookie works", async () => {
		assert.equal(await serverToken("GET", { cookie: CK }), "tok-123");
		assert.equal(await serverToken("HEAD", { cookie: CK }), "tok-123");
	});
	it("a cross-site GET with only the cookie is unauthenticated, unless it is a top-level navigation", async () => {
		assert.equal(await serverToken("GET", { cookie: CK, "sec-fetch-site": "cross-site" }), null);
		assert.equal(await serverToken("GET", { cookie: CK, "sec-fetch-site": "same-site" }), null);
		assert.equal(await serverToken("GET", { cookie: CK, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }), null);
		assert.equal(await serverToken("GET", { cookie: CK, "sec-fetch-site": "same-origin" }), "tok-123");
		assert.equal(await serverToken("GET", { cookie: CK, "sec-fetch-site": "none" }), "tok-123");
		assert.equal(await serverToken("GET", { cookie: CK, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }), "tok-123");
		assert.equal(cookieAuthAllowed("GET", new Headers({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" })), false);
	});
	it("a bad or malformed bearer does not fall back to the cookie", async () => {
		assert.equal(await serverToken("GET", { authorization: "Bearer", cookie: CK }), null);
		assert.equal(await serverToken("GET", { authorization: "Basic abc", cookie: CK }), null);
		assert.equal(await serverToken("GET", { authorization: "Bearer wrong", cookie: CK }), "wrong");
	});
	it("https reads only the __Host- cookie; http only the plain one", async () => {
		assert.equal(await serverToken("GET", { cookie: CK }, true), null);
		assert.equal(await serverToken("GET", { cookie: `${HUB_COOKIE_HOST}=tok-9` }, true), "tok-9");
		assert.equal(await serverToken("GET", { cookie: `${HUB_COOKIE_HOST}=tok-9` }, false), null);
	});
	it("a duplicated cookie is rejected, never first-wins", () => {
		assert.equal(cookieTokenOf(`${HUB_COOKIE}=a1; x=1; ${HUB_COOKIE}=b2`, false), undefined);
		assert.equal(cookieTokenOf(`${HUB_COOKIE}=a1`, false), "a1");
	});
	it("an invalid cookie value is no token (401), never a throw", () => {
		for (const v of ["%E0%A4%A", "a b", "%20", "", "x".repeat(600), "a%00b", "<script>"]) assert.equal(cookieTokenOf(`${HUB_COOKIE}=${v}`, false), undefined, v);
	});
});

describe("cookie attributes", () => {
	it("http: plain name, no Secure; https: __Host- name, Secure, Path=/, no Domain; SameSite=Lax and 30-day Max-Age", () => {
		const http = buildHubCookie("tok-1", false);
		assert.match(http, /^wolfpack_hub_token=tok-1; Path=\/; SameSite=Lax; Max-Age=2592000$/);
		const https = buildHubCookie("tok-1", true);
		assert.match(https, /^__Host-wolfpack_hub_token=tok-1; Path=\/; SameSite=Lax; Max-Age=2592000; Secure$/);
		assert.doesNotMatch(https, /Domain/i);
	});
	it("clear is Max-Age=0 (on https also the legacy plain name)", () => {
		assert.deepEqual(clearHubCookies(false).map((c) => /Max-Age=0/.test(c)), [true]);
		const c = clearHubCookies(true);
		assert.equal(c.length, 2);
		assert.ok(c.every((x) => /Max-Age=0/.test(x)));
		assert.ok(c[0]!.startsWith("__Host-") && c[0]!.includes("Secure"));
	});
	it("encoding round-trips through the Cookie header", () => {
		for (const t of ["abc", "a.b-c_d~e+f/g=", "tok-0123456789abcdef"]) {
			const set = buildHubCookie(t, false).split(";")[0]!;
			assert.equal(cookieTokenOf(`z=1; ${set}`, false), t);
		}
	});
	it("syncHubCookie writes through document.cookie: re-mirrors a stored token, clears when none", () => {
		const g = globalThis as unknown as { document?: { cookie: string }; location?: { protocol: string } };
		const writes: string[] = [];
		g.document = { set cookie(v: string) { writes.push(v); } } as unknown as { cookie: string };
		try {
			g.location = { protocol: "https:" };
			const st = mem();
			saveHubToken(st, "tok-7");
			syncHubCookie(st);
			assert.equal(writes.length, 2);
			assert.ok(writes.every((w) => w.startsWith("__Host-wolfpack_hub_token=tok-7") && w.endsWith("; Secure")));
			writes.length = 0;
			clearHubToken(st);
			assert.ok(writes.every((w) => /Max-Age=0/.test(w)) && writes.length === 2);
			writes.length = 0;
			g.location = { protocol: "http:" };
			syncHubCookie(st); // nothing stored -> clear
			assert.equal(writes.length, 1);
			assert.match(writes[0]!, /^wolfpack_hub_token=; .*Max-Age=0$/);
		} finally {
			delete g.document;
			delete g.location;
		}
	});
});
