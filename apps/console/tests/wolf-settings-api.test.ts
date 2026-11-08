import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpConsoleClient, ProtocolError, type ConsoleClient } from "@wolfpack/client";
import { createWolfSettingsApi } from "../src/server/wolf-settings-api.ts";

const stub = (p: Record<string, unknown>) => () => p as unknown as ConsoleClient;
const view = { etag: "e2", config: {}, editable: ["subagents.maxRunning"], tierModels: {}, env: [], restartNeeded: false, restartable: true, restartAvailableInSeconds: 0 };
const put = (body: unknown, ifMatch?: string) => new Request("http://c/x", { method: "PUT", headers: ifMatch ? { "If-Match": ifMatch } : {}, body: JSON.stringify(body) });

describe("wolf settings API", () => {
	it("save passes the changed keys and the browser's If-Match to the client", async () => {
		const calls: unknown[][] = [];
		const api = createWolfSettingsApi(stub({ putWolfSettings: async (...a: unknown[]) => (calls.push(a), view) }));
		const res = await api.save("hal", put({ set: { "subagents.maxRunning": 3 } }, "e1"));
		assert.equal(res.status, 200);
		assert.deepEqual(calls, [["hal", { "subagents.maxRunning": 3 }, "e1"]]);
	});
	it("passes 400, 409 and 429 (with retryAfterSeconds) through with the protocol code", async () => {
		const fail = (code: "invalid_request" | "conflict" | "rate_limited", details?: Record<string, string | number>) =>
			createWolfSettingsApi(stub({ putWolfSettings: async () => { throw new ProtocolError(code, "nope", false, details); } })).save("hal", put({ set: {} }, "e1"));
		const bad = await fail("invalid_request");
		assert.equal(bad.status, 400);
		assert.equal((await fail("conflict")).status, 409);
		const slow = await fail("rate_limited", { retryAfterSeconds: 42 });
		assert.equal(slow.status, 429);
		assert.deepEqual((await slow.json()).details, { retryAfterSeconds: 42 });
	});
	it("refuses a save without If-Match (400) before reaching the client", async () => {
		const api = createWolfSettingsApi(stub({ putWolfSettings: async () => { throw new Error("must not be called"); } }));
		const res = await api.save("hal", put({ set: { "subagents.maxRunning": 3 } }));
		assert.equal(res.status, 400);
		assert.equal((await res.json()).code, "invalid_request");
	});
	it("reveal and restart go to the client for the named wolf", async () => {
		const calls: unknown[][] = [];
		const api = createWolfSettingsApi(stub({
			revealWolfSetting: async (...a: unknown[]) => (calls.push(a), { name: "WORK_TOKEN", value: "v" }),
			restartWolf: async (...a: unknown[]) => (calls.push(a), { restarting: true }),
		}));
		const r = await api.reveal("sfo", new Request("http://c/x", { method: "POST", body: JSON.stringify({ source: "env", name: "WORK_TOKEN" }) }));
		assert.deepEqual(await r.json(), { name: "WORK_TOKEN", value: "v" });
		assert.deepEqual(await (await api.restart("sfo")).json(), { restarting: true });
		assert.deepEqual(calls, [["sfo", "env", "WORK_TOKEN"], ["sfo"]]);
	});
	it("answers 503 when the client has no settings support (mock mode)", async () => {
		assert.equal((await createWolfSettingsApi(stub({})).get("hal")).status, 503);
	});
});
