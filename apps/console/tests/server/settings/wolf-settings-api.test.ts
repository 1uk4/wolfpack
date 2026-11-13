import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpConsoleClient, ProtocolError, type ConsoleClient } from "@wolfpack/client";
import { createWolfSettingsApi } from "../../../src/server/settings/wolf-settings-api.ts";

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
	describe("model saves are checked against the catalog", () => {
		const catalog = () => [
			{ id: "claude-opus-5-5", name: "Opus", provider: "anthropic" },
			{ id: "gpt-x", name: "GPT X", provider: "openai" },
		];
		const api = (config: Record<string, unknown>, calls: unknown[][] = []) =>
			createWolfSettingsApi(stub({ getWolfSettings: async () => ({ ...view, config }), putWolfSettings: async (...a: unknown[]) => (calls.push(a), view) }), { catalog });
		it("refuses a memory.model that is not an Anthropic catalog model, with 400 and nothing saved", async () => {
			const calls: unknown[][] = [];
			for (const m of ["gpt-x", "made-up"]) {
				const res = await api({}, calls).save("dewey", put({ set: { "memory.model": m } }, "e1"));
				assert.equal(res.status, 400);
				assert.match((await res.json()).error, /Anthropic/);
			}
			assert.equal(calls.length, 0);
		});
		it("accepts an Anthropic catalog model for memory.model", async () => {
			const calls: unknown[][] = [];
			assert.equal((await api({}, calls).save("dewey", put({ set: { "memory.model": "claude-opus-5-5" } }, "e1"))).status, 200);
			assert.equal(calls.length, 1);
		});
		it("refuses a chat model of another provider than the wolf's own, or off the catalog", async () => {
			const calls: unknown[][] = [];
			const own = { models: { main: { provider: "anthropic", model: "claude-opus-5-5" } } };
			assert.equal((await api(own, calls).save("dewey", put({ set: { "models.main.model": "gpt-x" } }, "e1"))).status, 400);
			assert.equal((await api(own, calls).save("dewey", put({ set: { "models.main.model": "nope" } }, "e1"))).status, 400);
			assert.equal(calls.length, 0);
		});
		it("a subscription wolf (claude-stateless) may pick an Anthropic catalog model, and the provider stays", async () => {
			const calls: unknown[][] = [];
			const sub = { models: { main: { provider: "claude-stateless", model: "claude-opus-5-5" } } };
			assert.equal((await api(sub, calls).save("hal", put({ set: { "models.main.model": "claude-opus-5-5" } }, "e1"))).status, 200);
			assert.deepEqual(calls, [["hal", { "models.main.model": "claude-opus-5-5" }, "e1"]]);
		});
	});
	describe("provider and model are checked as a pair", () => {
		const catalog = () => [
			{ id: "claude-opus-5-5", name: "Opus", provider: "anthropic" },
			{ id: "gpt-x", name: "GPT X", provider: "openai" },
		];
		const api = (config: Record<string, unknown>, tierProviders: Record<string, string> | undefined, calls: unknown[][] = []) =>
			createWolfSettingsApi(stub({ getWolfSettings: async () => ({ ...view, config, ...(tierProviders ? { tierProviders } : {}) }), putWolfSettings: async (...a: unknown[]) => (calls.push(a), view) }), { catalog });
		const save = (a: ReturnType<typeof api>, set: Record<string, unknown>) => a.save("dewey", put({ set }, "e1"));
		it("a provider and model changed together pass when they match and are refused when they don't", async () => {
			const calls: unknown[][] = [];
			const a = api({}, { main: "anthropic" }, calls);
			assert.equal((await save(a, { "models.main.provider": "openai", "models.main.model": "gpt-x" })).status, 200);
			assert.equal((await save(a, { "models.main.provider": "openai", "models.main.model": "claude-opus-5-5" })).status, 400);
			assert.equal((await save(a, { "models.main.provider": "nowhere" })).status, 400);
			assert.equal(calls.length, 1);
		});
		it("checks models.smart.model and tiers.fast.model against the catalog for the tier's own provider", async () => {
			const calls: unknown[][] = [];
			const a = api({ models: { smart: { provider: "openai" } } }, { main: "anthropic", smart: "openai", fast: "anthropic" }, calls);
			assert.equal((await save(a, { "models.smart.model": "claude-opus-5-5" })).status, 400);
			assert.equal((await save(a, { "models.smart.model": "gpt-x" })).status, 200);
			assert.equal((await save(a, { "tiers.fast.model": "gpt-x" })).status, 400);
			assert.equal((await save(a, { "tiers.fast.model": "claude-opus-5-5" })).status, 200);
			assert.equal(calls.length, 2);
		});
		it("with no provider in wolf.yaml, uses the provider the wolf runs on, not Anthropic", async () => {
			const calls: unknown[][] = [];
			const a = api({}, { main: "openai" }, calls);
			assert.equal((await save(a, { "models.main.model": "claude-opus-5-5" })).status, 400);
			assert.equal((await save(a, { "models.main.model": "gpt-x" })).status, 200);
			assert.equal(calls.length, 1);
		});
		it("calls the catalog once per save", async () => {
			let n = 0;
			const a = createWolfSettingsApi(stub({ getWolfSettings: async () => view, putWolfSettings: async () => view }), { catalog: () => (n++, catalog()) });
			await save(a, { "models.main.provider": "openai", "models.main.model": "gpt-x", "memory.model": "claude-opus-5-5" });
			assert.equal(n, 1);
		});
	});
	it("answers 503 when the client has no settings support (mock mode)", async () => {
		assert.equal((await createWolfSettingsApi(stub({})).get("hal")).status, 503);
	});
});
