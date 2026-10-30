/** Hub sign-in: stored token -> bearer on /api, 401 -> token cleared; the console server prefers the forwarded token over the env one. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { bearerOf, clearHubToken, HUB_TOKEN_KEY, readHubToken, saveHubToken, tokenFromHash, withHubAuth, type TokenStorage } from "../src/core/hub-auth.ts";
import { createConsoleClient } from "../src/server/console-client.ts";

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
	it("a 401 from /api clears the token and signals sign-in", async () => {
		const storage = mem();
		saveHubToken(storage, "tok");
		let called = 0;
		const f = withHubAuth((async () => new Response("{}", { status: 401 })) as typeof fetch, { storage, origin: ORIGIN, onUnauthorized: () => called++ });
		assert.equal((await f("/api/a")).status, 401);
		assert.equal(readHubToken(storage), undefined);
		assert.equal(storage.m.has(HUB_TOKEN_KEY), false);
		assert.equal(called, 1);
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
	it("hub work reads use the browser's forwarded token, else the env token", async () => {
		const seen: (string | undefined)[] = [];
		const hub = createServer((req, res) => {
			seen.push(req.headers.authorization);
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ items: [] }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
		try {
			let fwd: string | undefined = "browser";
			const c = createConsoleClient({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "env" }, async () => fwd);
			await c.listWork!("w", { domain: "d" });
			fwd = undefined;
			await c.listWork!("w", { domain: "d" });
			assert.deepEqual(seen, ["Bearer browser", "Bearer env"]);
		} finally {
			hub.close();
		}
	});
});
