/**
 * The server response cache behind the graph and work-list routes (work-wolfpack-WT99MnL): revalidation with ETag/If-None-Match,
 * explicit invalidation, per-key entries, TTL expiry and per-credential isolation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cachedResponse, invalidate } from "../../src/server/response-cache.ts";

const req = (headers: Record<string, string> = {}) => new Request("http://x/api/kb/graph", { headers });
const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function counter(body: unknown) {
	const state = { calls: 0 };
	const compute = async () => {
		state.calls++;
		return ok(body)();
	};
	return { state, compute };
}

describe("response cache", () => {
	it("answers 304 with no body and no recompute when If-None-Match equals the etag", async () => {
		const { state, compute } = counter({ nodes: [1, 2, 3] });
		const opts = { ttlMs: 60_000, now: () => 0 };
		const first = await cachedResponse(req(), "k-etag", compute, opts);
		const etag = first.headers.get("etag");
		assert.match(etag ?? "", /^"[0-9a-f]{40,}"$/);
		assert.equal(first.headers.get("cache-control"), "private, no-cache");
		assert.deepEqual(await first.json(), { nodes: [1, 2, 3] });

		const second = await cachedResponse(req({ "if-none-match": etag! }), "k-etag", compute, opts);
		assert.equal(second.status, 304);
		assert.equal(await second.text(), "");
		assert.equal(state.calls, 1);
	});

	it("serves the cached body to a request with a stale etag", async () => {
		const { state, compute } = counter({ a: 1 });
		const opts = { ttlMs: 60_000, now: () => 0 };
		await cachedResponse(req(), "k-stale", compute, opts);
		const res = await cachedResponse(req({ "if-none-match": '"old"' }), "k-stale", compute, opts);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { a: 1 });
		assert.equal(state.calls, 1);
	});

	it("recomputes after invalidate(prefix) and the new body gets a new etag", async () => {
		let n = 0;
		const compute = async () => ok({ n: ++n })();
		const opts = { ttlMs: 60_000, now: () => 0 };
		const a = await cachedResponse(req(), "graph?x=1", compute, opts);
		invalidate("graph");
		const b = await cachedResponse(req({ "if-none-match": a.headers.get("etag")! }), "graph?x=1", compute, opts);
		assert.equal(b.status, 200);
		assert.deepEqual(await b.json(), { n: 2 });
		assert.notEqual(b.headers.get("etag"), a.headers.get("etag"));
	});

	it("keeps one entry per key", async () => {
		const one = counter({ q: 1 });
		const two = counter({ q: 2 });
		const opts = { ttlMs: 60_000, now: () => 0 };
		await cachedResponse(req(), "k-a", one.compute, opts);
		await cachedResponse(req(), "k-b", two.compute, opts);
		const a = await cachedResponse(req(), "k-a", one.compute, opts);
		const b = await cachedResponse(req(), "k-b", two.compute, opts);
		assert.deepEqual(await a.json(), { q: 1 });
		assert.deepEqual(await b.json(), { q: 2 });
		assert.equal(one.state.calls + two.state.calls, 2);
	});

	it("recomputes once the ttl has passed", async () => {
		let t = 0;
		const { state, compute } = counter({ a: 1 });
		const opts = { ttlMs: 1_000, now: () => t };
		await cachedResponse(req(), "k-ttl", compute, opts);
		t = 999;
		await cachedResponse(req(), "k-ttl", compute, opts);
		assert.equal(state.calls, 1);
		t = 1_001;
		await cachedResponse(req(), "k-ttl", compute, opts);
		assert.equal(state.calls, 2);
	});

	it("never shares an entry between different credentials, and never caches errors", async () => {
		const { state, compute } = counter({ a: 1 });
		const opts = { ttlMs: 60_000, now: () => 0 };
		await cachedResponse(req({ authorization: "Bearer one" }), "k-auth", compute, opts);
		await cachedResponse(req({ authorization: "Bearer two" }), "k-auth", compute, opts);
		assert.equal(state.calls, 2);

		let fails = 0;
		const failing = async () => {
			fails++;
			return new Response("{}", { status: 401 });
		};
		await cachedResponse(req(), "k-err", failing, opts);
		const res = await cachedResponse(req(), "k-err", failing, opts);
		assert.equal(res.status, 401);
		assert.equal(fails, 2);
	});

	it("is bounded: the oldest entries are dropped past the cap", async () => {
		const { state, compute } = counter({ a: 1 });
		const opts = { ttlMs: 60_000, now: () => 0, maxEntries: 2 };
		await cachedResponse(req(), "cap-1", compute, opts);
		await cachedResponse(req(), "cap-2", compute, opts);
		await cachedResponse(req(), "cap-3", compute, opts);
		await cachedResponse(req(), "cap-1", compute, opts);
		assert.equal(state.calls, 4);
	});
});
