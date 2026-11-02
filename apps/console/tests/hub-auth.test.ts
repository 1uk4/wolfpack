/** Hub sign-in: stored token -> bearer on /api, 401 -> token cleared; the console server prefers the forwarded token over the env one. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { bearerOf, cookieTokenOf, clearHubToken, HUB_AUTH_HEADER, HUB_TOKEN_KEY, readHubToken, saveHubToken, tokenFromHash, withHubAuth, type TokenStorage } from "../src/core/hub-auth.ts";
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
	it("with no request scope at all, the env token is used", async () => {
		const { hub, seen, url } = await startHub();
		try {
			const c = createConsoleClient({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "env" }, async () => undefined);
			await c.listWork!("w", { domain: "d" });
			assert.deepEqual(seen, ["Bearer env"]);
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

describe("cookie fallback for server-rendered navigations", () => {
	it("makeRequestToken: bearer wins, else the hub cookie, else null", async () => {
		const tok = (h: Record<string, string>) => makeRequestToken(async () => new Headers(h))();
		assert.equal(await tok({ authorization: "Bearer abc", cookie: "wolfpack_hub_token=zzz" }), "abc");
		assert.equal(await tok({ cookie: "a=1; wolfpack_hub_token=t%2Fk; b=2" }), "t/k");
		assert.equal(await tok({ cookie: "other=1" }), null);
		assert.equal(cookieTokenOf("wolfpack_hub_token=%E0%A4%A"), undefined);
	});
});
