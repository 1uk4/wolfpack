import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDataStore } from "../../src/core/data-store.ts";

type Call = { url: string; ifNoneMatch: string | null };

function harness(respond: (call: Call, n: number) => Response | Promise<Response>) {
	const calls: Call[] = [];
	let t = 1000;
	const store = createDataStore({
		fetch: (async (url: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const call = { url, ifNoneMatch: headers.get("If-None-Match") };
			calls.push(call);
			return respond(call, calls.length);
		}) as unknown as typeof fetch,
		now: () => t,
		maxEntries: 3,
	});
	return { store, calls, advance: (ms: number) => (t += ms) };
}

const json = (body: unknown, etag?: string) =>
	new Response(JSON.stringify(body), { status: 200, headers: etag ? { ETag: etag } : {} });

describe("data store", () => {
	it("serves a fresh cached value without fetching", async () => {
		const h = harness(() => json({ n: 1 }));
		assert.deepEqual(await h.store.load("/a", { maxAgeMs: 30_000 }), { n: 1 });
		h.advance(10_000);
		assert.deepEqual(await h.store.load("/a", { maxAgeMs: 30_000 }), { n: 1 });
		assert.equal(h.calls.length, 1);
		assert.deepEqual(h.store.read("/a")?.data, { n: 1 });
	});

	it("shares one request between concurrent loads", async () => {
		const h = harness(() => json({ n: 1 }));
		const [a, b] = await Promise.all([h.store.load("/a", { maxAgeMs: 0 }), h.store.load("/a", { maxAgeMs: 0 })]);
		assert.deepEqual(a, b);
		assert.equal(h.calls.length, 1);
	});

	it("refetches when the cached value is older than maxAgeMs", async () => {
		const h = harness((_c, n) => json({ n }));
		await h.store.load("/a", { maxAgeMs: 1000 });
		h.advance(2000);
		assert.deepEqual(await h.store.load("/a", { maxAgeMs: 1000 }), { n: 2 });
	});

	it("treats 304 as still fresh: keeps data, refreshes the age", async () => {
		const h = harness((c) => (c.ifNoneMatch === '"v1"' ? new Response(null, { status: 304 }) : json({ n: 1 }, '"v1"')));
		await h.store.load("/a", { maxAgeMs: 1000 });
		h.advance(5000);
		assert.deepEqual(await h.store.load("/a", { maxAgeMs: 1000 }), { n: 1 });
		assert.equal(h.calls[1]?.ifNoneMatch, '"v1"');
		assert.equal(h.store.read("/a")?.at, 6000);
	});

	it("invalidate(prefix) forces the next load to fetch and leaves other keys", async () => {
		const h = harness((_c, n) => json({ n }));
		await h.store.load("/api/x/1", { maxAgeMs: 60_000 });
		await h.store.load("/api/y", { maxAgeMs: 60_000 });
		h.store.invalidate("/api/x");
		await h.store.load("/api/x/1", { maxAgeMs: 60_000 });
		await h.store.load("/api/y", { maxAgeMs: 60_000 });
		assert.equal(h.calls.length, 3);
	});

	it("notifies subscribers on new data and stops after unsubscribe", async () => {
		const h = harness((_c, n) => json({ n }));
		const seen: unknown[] = [];
		const off = h.store.subscribe("/a", () => seen.push(h.store.read("/a")?.data));
		await h.store.load("/a", { maxAgeMs: 0 });
		off();
		await h.store.load("/a", { maxAgeMs: 0 });
		assert.deepEqual(seen, [{ n: 1 }]);
	});

	it("keeps at most maxEntries values, dropping the oldest", async () => {
		const h = harness(() => json({}));
		for (const k of ["/1", "/2", "/3", "/4"]) await h.store.load(k, { maxAgeMs: 0 });
		assert.equal(h.store.read("/1"), undefined);
		assert.ok(h.store.read("/4"));
	});

	it("keeps old data and rejects when the fetch fails", async () => {
		const h = harness((_c, n) => (n === 1 ? json({ n: 1 }) : new Response("no", { status: 500 })));
		await h.store.load("/a", { maxAgeMs: 0 });
		await assert.rejects(h.store.load("/a", { maxAgeMs: 0 }));
		assert.deepEqual(h.store.read("/a")?.data, { n: 1 });
	});
});
