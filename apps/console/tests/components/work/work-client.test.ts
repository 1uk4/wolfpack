/**
 * The Work page's own client: mounting /work must not re-request what the store already holds or has in flight.
 * The domain picker reads the KB graph; the graph page (or the palette) may be loading the same URL at that moment.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

const { createWorkClient } = await import("../../../components/work/work-client.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");

let urls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
	dataStore.clear();
	urls = [];
	globalThis.fetch = (async (input: string) => {
		urls.push(input);
		return Response.json({ domains: [{ name: "wolfpack", label: "Wolfpack" }], nodes: [], edges: [] });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("work client domains", () => {
	it("opening /work sends one /api/kb/graph request, joining one already in flight and reusing a stored one", async () => {
		const client = createWorkClient();
		const [a, b] = await Promise.all([client.domains(), client.domains()]);
		await client.domains();
		assert.deepEqual(a, [{ name: "wolfpack", label: "Wolfpack" }]);
		assert.deepEqual(b, a);
		assert.deepEqual(urls, ["/api/kb/graph"]);
	});
});
