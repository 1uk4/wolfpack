import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BusyError, NotFoundError, ProtocolError, type ConsoleClient } from "@wolfpack/client";
import { createKbActivityApi } from "../../../src/server/kb/kb-activity-api.ts";
import { kbActivityFixture } from "../../fixtures/kb-activity.ts";

const stub = (p: Record<string, unknown>) => () => p as unknown as ConsoleClient;
const failing = (e: Error) => createKbActivityApi(stub({ getKbActivity: async () => { throw e; } }));

describe("kb activity API", () => {
	it("200 passes the response and the query through", async () => {
		const calls: unknown[] = [];
		const api = createKbActivityApi(stub({ getKbActivity: async (q: unknown) => (calls.push(q), kbActivityFixture()) }));
		const res = await api.kbActivity(new URLSearchParams("since=7d&before=abc&limit=25&domain=wolfpack&junk=1"));
		assert.equal(res.status, 200);
		assert.deepEqual(calls, [{ since: "7d", before: "abc", limit: 25, domain: "wolfpack" }]);
		assert.equal((await res.json()).source.curator, "on");
	});
	it("no query passes an empty query", async () => {
		const calls: unknown[] = [];
		await createKbActivityApi(stub({ getKbActivity: async (q: unknown) => (calls.push(q), kbActivityFixture()) })).kbActivity();
		assert.deepEqual(calls, [{}]);
	});
	it("a non-integer limit is 400 without calling the hub", async () => {
		let called = false;
		const res = await createKbActivityApi(stub({ getKbActivity: async () => ((called = true), kbActivityFixture()) })).kbActivity(new URLSearchParams("limit=abc"));
		assert.equal(res.status, 400);
		assert.equal(called, false);
	});
	it("error mapping", async () => {
		assert.equal((await failing(new ProtocolError("kb_unavailable", "x", false)).kbActivity()).status, 409);
		assert.equal((await failing(new ProtocolError("invalid_request", "bad since", false)).kbActivity()).status, 400);
		assert.equal((await failing(new ProtocolError("unauthorized", "no", false)).kbActivity()).status, 401);
		assert.equal((await failing(new ProtocolError("engine_error", "x", false)).kbActivity()).status, 502);
		assert.equal((await failing(new NotFoundError("gone")).kbActivity()).status, 404);
		assert.equal((await failing(new BusyError("busy")).kbActivity()).status, 409);
		const res = await failing(new Error("boom")).kbActivity();
		assert.equal(res.status, 500);
		assert.equal((await res.json()).error, "Internal error");
	});
	it("a client without getKbActivity → 409 kb_unavailable", async () => {
		const res = await createKbActivityApi(stub({})).kbActivity();
		assert.equal(res.status, 409);
		assert.equal((await res.json()).code, "kb_unavailable");
	});
	it("a hub-auth 401 carries the sign-out marker; a plain 401 does not", async () => {
		const hub = await failing(Object.assign(new ProtocolError("unauthorized", "revoked", false), { hubAuth: true })).kbActivity();
		assert.equal(hub.status, 401);
		assert.equal(hub.headers.get("X-Wolfpack-Hub-Auth"), "required");
		const plain = await failing(new ProtocolError("unauthorized", "wolf host", false)).kbActivity();
		assert.equal(plain.status, 401);
		assert.equal(plain.headers.get("X-Wolfpack-Hub-Auth"), null);
	});
});
