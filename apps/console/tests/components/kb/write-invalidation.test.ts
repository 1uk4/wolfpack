/**
 * A write the console makes through kb-client (work edit, promote, thread create…) drops the cached roster, thread, work and graph reads;
 * a failed write and a plain read leave them alone.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

const { fetchWolves, fetchKbGraph, fetchWorkList, fetchWolfThreads, postConsolidate } = await import("../../../components/kb/kb-client.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");

let calls: string[] = [];
let writeStatus = 200;
const realFetch = globalThis.fetch;
beforeEach(() => {
	dataStore.clear();
	calls = [];
	writeStatus = 200;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		return init?.method === "POST" ? Response.json({}, { status: writeStatus }) : Response.json({ wolves: [], threads: [], nodes: [], items: [] });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const warm = async () => {
	await fetchWolves(60_000);
	await fetchKbGraph({}, 60_000);
	await fetchWorkList("hal", "d", true, 60_000);
	await fetchWolfThreads("hal", 60_000);
	calls = [];
};
const reread = async () => {
	await fetchWolves(60_000);
	await fetchKbGraph({}, 60_000);
	await fetchWorkList("hal", "d", true, 60_000);
	await fetchWolfThreads("hal", 60_000);
	return calls.filter((c) => c.startsWith("GET"));
};

describe("kb-client writes", () => {
	it("a successful POST makes the roster, graph, work list and thread list read again", async () => {
		await warm();
		await postConsolidate("hal");
		calls = [];
		assert.deepEqual((await reread()).sort(), ["GET /api/kb/graph", "GET /api/wolves", "GET /api/wolves/hal/threads", "GET /api/wolves/hal/work?domain=d&graduated=true"]);
	});

	it("a failed POST leaves the stored reads alone", async () => {
		await warm();
		writeStatus = 500;
		await postConsolidate("hal");
		calls = [];
		assert.deepEqual(await reread(), []);
	});
});
