/** Owner presence route (work-wolfpack-BPwZ7wf): forwards one owner-viewing event to the hub with the caller's bearer; never errors. Hub faked at fetch. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPresenceApi } from "../../../src/server/pack/presence-api.ts";

const req = (body: unknown, token: string | null = "dev-token") =>
	new Request("http://c/api/activity/presence", { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const env = { WOLFPACK_HUB_URL: "http://hub.test:3150/" };

describe("owner presence API", () => {
	it("forwards one owner-viewing event to the hub with the caller's bearer", async () => {
		const calls: { url: string; auth: string | null; body: any }[] = [];
		const fetchStub = (async (url: string, init: RequestInit) => {
			calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
			return Response.json({ accepted: 1, dropped: 0 }, { status: 202 });
		}) as unknown as typeof fetch;
		const res = await createPresenceApi({ env, fetch: fetchStub, now: () => 1000, id: () => "e1" }).publish(req({ kind: "work-item", id: "work-wolfpack-X", title: "  Hi  ", ttlMs: 120000 }));
		assert.equal(res.status, 204);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "http://hub.test:3150/v1/activity");
		assert.equal(calls[0]!.auth, "Bearer dev-token");
		assert.deepEqual(calls[0]!.body, {
			v: 1,
			events: [{ v: 1, id: "e1", pack: "-", ts: 1000, ttlMs: 120000, actor: { kind: "owner" }, verb: "owner-viewing", target: { kind: "work-item", id: "work-wolfpack-X", title: "Hi" } }],
		});
	});

	it("answers 204 and does not call the hub without a hub, a bearer or a valid target", async () => {
		let n = 0;
		const fetchStub = (async () => (n++, new Response(null, { status: 202 }))) as unknown as typeof fetch;
		assert.equal((await createPresenceApi({ env: {}, fetch: fetchStub }).publish(req({ kind: "thread", id: "t" }))).status, 204);
		assert.equal((await createPresenceApi({ env, fetch: fetchStub }).publish(req({ kind: "thread", id: "t" }, null))).status, 204);
		assert.equal((await createPresenceApi({ env, fetch: fetchStub }).publish(req({ kind: "wolf", id: "t" }))).status, 204);
		assert.equal(n, 0);
	});

	it("swallows a hub error and a hub that never answers (short timeout)", async () => {
		const boom = (async () => Response.json({ error: "x" }, { status: 500 })) as unknown as typeof fetch;
		assert.equal((await createPresenceApi({ env, fetch: boom }).publish(req({ kind: "thread", id: "t" }))).status, 204);
		const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
		const t0 = Date.now();
		assert.equal((await createPresenceApi({ env, fetch: hang, timeoutMs: 30 }).publish(req({ kind: "thread", id: "t" }))).status, 204);
		assert.ok(Date.now() - t0 < 1000);
	});
});
