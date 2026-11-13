/** Pack inventory on the console server (work-wolfpack-ZproKxi): the hub client and its merge into createPackHealth's snapshot. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InventoryListed } from "@wolfpack/protocol";
import { createHealthApi, inventoryReader, packHealth } from "../../../src/server/pack/health-api.ts";
import { readInventory } from "../../../src/server/pack/inventory.ts";

const manifest = (v: string) => async () => ({ manifest: { schema: 1 as const, generatedAt: "", components: { workerd: { version: v, tag: "", sha: "", publishedAt: "", notesUrl: "" }, wolfd: { version: v, tag: "", sha: "", publishedAt: "", notesUrl: "" } } } });
const listed = (over: Partial<InventoryListed>): InventoryListed => ({ machine: "sfo-01", kind: "workerd", id: "sfo-01-wolves", ageS: 3, ...over });
function hub(entries: InventoryListed[], status = 200) {
	const calls: { url: string; method?: string; auth?: string; body?: string }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>)?.Authorization, body: init?.body as string | undefined });
		return status === 200 ? Response.json({ entries, hubMachine: "sfo-01" }) : new Response("{}", { status });
	}) as unknown as typeof fetch;
	return { f, calls };
}
describe("readInventory (the viewer's own sign-in)", () => {
	it("reads /v1/inventory with the caller's bearer and says why when it cannot", async () => {
		const h = hub([listed({ version: "0.1.5", channel: "stable" })]);
		const ok = await readInventory({ hubUrl: "http://hub", token: "viewer-tok", manifest: manifest("0.1.6"), fetch: h.f });
		assert.equal(h.calls[0]!.auth, "Bearer viewer-tok");
		assert.equal(ok.state, "ok");
		assert.deepEqual(ok.state === "ok" ? ok.rows.map((r) => r.latest) : [], ["0.1.6"]);
		const none = hub([]);
		assert.equal((await readInventory({ hubUrl: "http://hub", token: undefined, manifest: manifest("0.1.6"), fetch: none.f })).state, "signed-out");
		assert.equal(none.calls.length, 0);
		assert.equal((await readInventory({ hubUrl: "http://hub", token: "t", manifest: manifest("0.1.6"), fetch: hub([], 401).f })).state, "signed-out");
		assert.equal((await readInventory({ hubUrl: "http://hub", token: "t", manifest: manifest("0.1.6"), fetch: hub([], 502).f })).state, "unavailable");
		assert.equal((await readInventory({ hubUrl: undefined, token: "t", manifest: manifest("0.1.6") })).state, "unavailable");
		const hang = ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
		assert.equal((await readInventory({ hubUrl: "http://hub", token: "t", manifest: manifest("0.1.6"), fetch: hang, timeoutMs: 20 })).state, "unavailable");
	});
});

describe("GET /api/health/inventory", () => {
	it("reads with the request's bearer and answers the state, never an error status", async () => {
		const seen: (string | undefined)[] = [];
		const api = createHealthApi({ readInventory: async (t: string | undefined) => (seen.push(t), t === "good" ? { state: "ok", rows: [], hubMachine: "sfo-01" } : t ? { state: "unavailable" } : { state: "signed-out" }) } as unknown as Parameters<typeof createHealthApi>[0]);
		const get = async (auth?: string) => (await api.inventory(new Request("http://c/api/health/inventory", { headers: auth ? { authorization: auth } : {} }))).json();
		assert.deepEqual(await get("Bearer good"), { state: "ok", rows: [], hubMachine: "sfo-01" });
		assert.deepEqual(await get("Bearer other"), { state: "unavailable" });
		assert.deepEqual(await get(), { state: "signed-out" });
		assert.deepEqual(seen, ["good", "other", undefined]);
	});
});

describe("inventoryReader (what GET /api/health/inventory runs)", () => {
	const env = { WOLFPACK_HUB_URL: "http://hub", WOLFPACK_HUB_TOKEN: "env-secret", WOLFPACK_UPDATE_MANIFEST_URL: "http://m/stable", WOLFPACK_UPDATE_MAIN_MANIFEST_URL: "http://m/main" };
	const rows = [listed({ version: "0.1.5", channel: "stable" })];
	function stub(o: { hub?: () => Promise<Response>; manifestHangs?: boolean } = {}) {
		const calls: { url: string; auth: string | null }[] = [];
		const f = (async (url: string, init?: RequestInit) => {
			calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
			if (url.startsWith("http://m/")) return o.manifestHangs ? new Promise<Response>(() => {}) : Response.json((await manifest("0.1.6")()).manifest);
			return o.hub ? o.hub() : Response.json({ entries: rows, hubMachine: "sfo-01" });
		}) as unknown as typeof fetch;
		return { f, calls };
	}
	it("forwards only the caller's bearer, never the env token; no bearer means signed-out with no hub call; 401 is signed-out; a hub that hangs is unavailable", async () => {
		const s = stub();
		const read = inventoryReader(env, { fetch: s.f, timeoutMs: 30 });
		assert.deepEqual(await read(undefined), { state: "signed-out" });
		assert.equal(s.calls.length, 0);
		assert.equal((await read("viewer")).state, "ok");
		assert.deepEqual(s.calls.filter((c) => c.url.startsWith("http://hub")).map((c) => c.auth), ["Bearer viewer"]);
		assert.equal(s.calls.some((c) => c.auth?.includes("env-secret")), false);
		assert.equal((await inventoryReader(env, { fetch: stub({ hub: async () => new Response("{}", { status: 403 }) }).f })("t")).state, "signed-out");
		const hang = ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
		assert.equal((await inventoryReader(env, { fetch: hang, timeoutMs: 30 })("t")).state, "unavailable");
	});
	it("a slow manifest does not push the answer past the deadline (latest is null), and the manifest fetchers are reused across calls", async () => {
		const slow = stub({ manifestHangs: true });
		const t0 = Date.now();
		const out = await inventoryReader(env, { fetch: slow.f, timeoutMs: 100 })("viewer");
		assert.ok(Date.now() - t0 < 1000, "answered within the deadline, not the manifest's own timeout");
		assert.deepEqual(out.state === "ok" ? out.rows.map((r) => r.latest) : "not ok", [null]);
		const s = stub();
		const read = inventoryReader(env, { fetch: s.f });
		await read("viewer");
		await read("viewer");
		assert.equal(s.calls.filter((c) => c.url === "http://m/stable").length, 1);
	});
});

describe("GET /api/health (unauthenticated)", () => {
	it("never reads or exposes the hub inventory, even when the console has an env hub token", async () => {
		const calls: { url: string; auth: string | null }[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => (calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") }), Response.json({ entries: [listed({ version: "0.1.5" })], hubMachine: "sfo-01" }))) as typeof fetch;
		try {
			const ph = packHealth({ WOLFPACK_HUB_URL: "http://hub", WOLFPACK_HUB_TOKEN: "env-secret" });
			await new Promise((r) => setTimeout(r, 50));
			assert.equal("inventory" in (await ph.tick()), false);
			assert.equal(calls.some((c) => c.url.includes("/v1/inventory") || c.auth?.includes("env-secret")), false);
		} finally {
			globalThis.fetch = real;
		}
	});
});
