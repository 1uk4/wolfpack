/** Pack inventory on the console server (work-wolfpack-ZproKxi): the hub client and its merge into createPackHealth's snapshot. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InventoryListed } from "@wolfpack/protocol";
import { createInventoryClient } from "../../../src/server/pack/inventory.ts";
import { createPackHealth } from "../../../src/server/pack/pack-health.ts";

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
const client = (h: ReturnType<typeof hub>, main = "0.1.7-main.2", stable = "0.1.6") =>
	createInventoryClient({
		hubUrl: "http://hub",
		token: () => "tok",
		self: () => ({ machine: "mac", kind: "console", id: "console", version: "0.1.19" }),
		manifest: async (c) => (c === "main" ? manifest(main)() : manifest(stable)()),
		fetch: h.f,
	});

describe("inventory client", () => {
	it("judges behind against the channel each row reported; no channel or a -dev version gets no verdict", async () => {
		const h = hub([
			listed({ version: "0.1.5", channel: "stable" }),
			listed({ id: "a", kind: "wolfd", version: "0.1.6-main.1", channel: "main" }),
			listed({ id: "b", kind: "wolfd", version: "0.1.5" }),
			listed({ id: "c", kind: "wolfd", version: "0.1.0-dev", channel: "main" }),
		]);
		const c = client(h);
		await c.poll();
		assert.deepEqual(c.view()!.rows.map((r) => r.latest), ["0.1.6", "0.1.7-main.2", null, null]);
		assert.equal(h.calls[0]!.auth, "Bearer tok");
	});

	it("a hub 404 means no inventory; a later failure keeps the last rows, marked stale", async () => {
		const none = client(hub([], 404));
		await none.poll();
		assert.equal(none.view(), null);
		let status = 200;
		const f = (async () => (status === 200 ? Response.json({ entries: [listed({ version: "0.1.6", channel: "stable" })], hubMachine: "sfo-01" }) : new Response("{}", { status }))) as unknown as typeof fetch;
		const c = createInventoryClient({ hubUrl: "http://hub", token: () => "t", self: () => ({ machine: "m", kind: "console", id: "console" }), manifest: manifest("0.1.6"), fetch: f });
		await c.poll();
		status = 502;
		await c.poll();
		assert.equal(c.view()!.stale, true);
		assert.equal(c.view()!.rows.length, 1);
	});

	it("stops polling for 5 minutes after a 401, 403 or 404, then tries again", async () => {
		for (const status of [401, 403, 404]) {
			const h = hub([], status);
			let t = 1_000_000;
			const c = createInventoryClient({ hubUrl: "http://hub", token: () => "t", self: () => ({ machine: "m", kind: "console", id: "console" }), manifest: manifest("0.1.6"), fetch: h.f, now: () => t });
			await c.poll();
			await c.poll();
			assert.equal(h.calls.length, 1, String(status));
			t += 5 * 60_000 + 1;
			await c.poll();
			assert.equal(h.calls.length, 2, String(status));
		}
	});

	it("heartbeats the console's own entry and backs off after a 403", async () => {
		const h = hub([], 403);
		const c = client(h);
		await c.heartbeat();
		await c.heartbeat();
		assert.equal(h.calls.length, 1);
		assert.deepEqual(JSON.parse(h.calls[0]!.body!), { entry: { machine: "mac", kind: "console", id: "console", version: "0.1.19" } });
	});
});

describe("createPackHealth with an inventory", () => {
	const targets = { hub: "http://127.0.0.1:1/healthz", workerds: [], wolves: [] };
	const fetch404 = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
	it("lists other machines' rows and drops the console's own machine (local probes win); no inventory leaves it null", async () => {
		const h = hub([listed({ version: "0.1.5", channel: "stable" }), listed({ machine: "mac", kind: "workerd", id: "mac-1uk4", version: "0.1.9" })]);
		const c = client(h);
		await c.poll();
		const ph = createPackHealth({ targets, consoleHost: "mac", fetch: fetch404, log: () => {}, inventory: () => c.view() });
		const s = await ph.tick();
		assert.deepEqual(s.inventory!.rows.map((r) => [r.machine, r.id, r.latest]), [["sfo-01", "sfo-01-wolves", "0.1.6"]]);
		const bare = createPackHealth({ targets, consoleHost: "mac", fetch: fetch404, log: () => {} });
		assert.equal((await bare.tick()).inventory, null);
	});
});
