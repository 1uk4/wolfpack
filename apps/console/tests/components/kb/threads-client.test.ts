/**
 * The per-wolf threads list through the client store: readers that open together (sidebar, palette, needs-you…) share one
 * request per wolf, and a thread create/archive/rename the console made itself makes the next read go to the server again.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

const { fetchWolfThreads, invalidateThreads, openFeatureThread } = await import("../../../components/kb/kb-client.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");

let calls: { url: string; method: string }[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
	dataStore.clear();
	calls = [];
	globalThis.fetch = (async (input: string, init?: RequestInit) => {
		calls.push({ url: input, method: init?.method ?? "GET" });
		return Response.json(init?.method === "POST" ? { id: "t9", title: "T" } : { threads: [{ id: "t1", title: "One" }] });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("fetchWolfThreads", () => {
	it("two readers opening together send one request per wolf", async () => {
		const [a, b, c] = await Promise.all([fetchWolfThreads("hal"), fetchWolfThreads("hal"), fetchWolfThreads("jack")]);
		assert.ok(a.ok && b.ok && c.ok);
		assert.deepEqual(calls.map((c) => c.url).sort(), ["/api/wolves/hal/threads", "/api/wolves/jack/threads"]);
	});

	it("a forced read (maxAgeMs 0) goes to the server even when the list is fresh", async () => {
		await fetchWolfThreads("hal");
		await fetchWolfThreads("hal", 0);
		assert.equal(calls.length, 2);
	});

	it("creating a thread makes the next read refetch", async () => {
		await fetchWolfThreads("hal");
		await openFeatureThread("hal", "work-x-1");
		await fetchWolfThreads("hal");
		assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "GET"]);
	});

	it("invalidateThreads (for call sites that write with their own fetch) makes the next read refetch", async () => {
		await fetchWolfThreads("hal");
		invalidateThreads("hal");
		await fetchWolfThreads("hal");
		assert.equal(calls.length, 2);
	});
});
