/**
 * Pack Keys API (work-wolfpack-6EmU8pu): createKeysApi behind the real owner gate, hub faked at fetch.
 * Seams: GET machines (inventory + machine keys merged), POST key ack. Commands go through the Machines route (machines-api.test.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHealthApi } from "../../../src/server/pack/health-api.ts";
import { createKeysApi } from "../../../src/server/pack/keys-api.ts";
import { createSessionWitness } from "../../../src/server/thread/session-witness.ts";

function setup(routes: Record<string, { status: number; body: unknown }>) {
	const calls: { method: string; url: string; body: unknown }[] = [];
	const hubFetch = (async (url: string, init?: RequestInit) => {
		calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const path = new URL(url).pathname;
		const r = routes[path] ?? { status: 404, body: {} };
		return Response.json(r.body, { status: r.status });
	}) as unknown as typeof fetch;
	const witness = createSessionWitness({ file: undefined });
	const gateApi = createHealthApi({ checkToken: async (t: string) => (t === "owner" ? "accepted" : "rejected"), witness } as unknown as Parameters<typeof createHealthApi>[0]);
	const api = createKeysApi({ gate: (req) => gateApi.gate(req, "key change"), env: { WOLFPACK_HUB_URL: "http://hub.test:3150", WOLFPACK_HUB_TOKEN: "op" }, fetch: hubFetch });
	return { api, calls };
}
const req = (method: string, body?: unknown, token: string | null = "owner") =>
	new Request("http://c/x", { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("Pack keys API", () => {
	it("merges inventory key presence with the hub's machine public keys; never carries a value", async () => {
		const { api } = setup({
			"/v1/inventory": { status: 200, body: { hubMachine: "sfo-01", entries: [{ machine: "sfo-01", kind: "workerd", id: "sfo-01-wolves", ageS: 1, keys: [{ slot: "anthropic", present: true, masked: "••••abcd", source: "pack", shadowsEnv: true }] }] } },
			"/v1/machines/keys": { status: 200, body: { keys: { "sfo-01-wolves": { pubkey: "PK", fingerprint: "fp1", changed: true } } } },
		});
		const res = await api.machines(req("GET"));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { machines: Record<string, unknown>[] };
		assert.deepEqual(body.machines, [{ hostId: "sfo-01-wolves", machine: "sfo-01", online: true, canSetKeys: true, pubkey: "PK", fingerprint: "fp1", keyChanged: true, slots: [{ slot: "anthropic", present: true, masked: "••••abcd", source: "pack", shadowsEnv: true }] }]);
	});

	it("forwards the fingerprint being accepted to the hub's ack, and passes its 409 through", async () => {
		const { api, calls } = setup({ "/v1/machines/box/key/ack": { status: 409, body: { code: "conflict" } } });
		const res = await api.ack(req("POST", { fingerprint: "ff00" }), "box");
		assert.equal(res.status, 409);
		assert.deepEqual(calls[0]!.body, { fingerprint: "ff00" });
		assert.equal((await api.ack(req("POST", { fingerprint: "ff00" }, null), "box")).status, 401);
	});
});
