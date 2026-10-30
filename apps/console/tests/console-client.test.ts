/** The console client factory: env decides mock vs wolf, and whether work reads come from a hub. */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { HttpConsoleClient, MockConsoleClient } from "@wolfpack/client";
import { composeWorkReads, createConsoleClient } from "../src/server/console-client.ts";

describe("createConsoleClient", () => {
	it("defaults to the mock, or an HTTP client with WOLFPACK_API_URL", () => {
		assert.ok(createConsoleClient({}) instanceof MockConsoleClient);
		assert.ok(createConsoleClient({ WOLFPACK_API_URL: "http://127.0.0.1:1" }) instanceof HttpConsoleClient);
	});

	it("WOLFPACK_HUB_URL (+ WOLFPACK_HUB_KEY) points work reads at the hub", async () => {
		const seen: { url?: string; key?: string }[] = [];
		const hub = createServer((req, res) => {
			seen.push({ url: req.url, key: String(req.headers["x-api-key"]) });
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ items: [] }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
		try {
			for (const env of [{ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_KEY: "k" }, { WOLFPACK_API_URL: "http://127.0.0.1:1", WOLFPACK_HUB_URL: url, WOLFPACK_HUB_KEY: "k" }]) {
				seen.length = 0;
				const c = createConsoleClient(env);
				assert.deepEqual(await c.listWork!("1uk4", { domain: "wolfpack" }), { items: [] });
				assert.deepEqual(seen, [{ url: "/v1/work?domain=wolfpack", key: "k" }]);
			}
		} finally {
			hub.close();
		}
	});
});

describe("WOLFPACK_HUB_RELAY (relay mode)", () => {
	it("sends wolf-scoped requests and streams to the hub with the request's token; no request token is a hub-auth 401", async () => {
		const seen: { url?: string; auth?: string }[] = [];
		const hub = createServer((req, res) => {
			seen.push({ url: req.url, auth: String(req.headers.authorization) });
			if (req.url?.endsWith("/stream")) {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				return void res.end("data: [DONE]\n\n");
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ threads: [] }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
		try {
			const env = { WOLFPACK_HUB_URL: url, WOLFPACK_HUB_RELAY: "1", WOLFPACK_API_URL: "http://127.0.0.1:1" };
			const c = createConsoleClient(env, async () => "tok-1");
			assert.deepEqual(await c.listThreads("alpha"), []);
			for await (const _ of c.watch("alpha/home")) void _;
			assert.deepEqual(seen.map((s) => [s.url, s.auth]), [["/v1/wolves/alpha/threads", "Bearer tok-1"], ["/v1/threads/alpha%2Fhome/stream", "Bearer tok-1"]]);
			const unpaired = createConsoleClient(env, async () => null);
			await assert.rejects(unpaired.listThreads("alpha"), (e: Error & { hubAuth?: boolean }) => e.hubAuth === true);
		} finally {
			hub.closeAllConnections();
			hub.close();
		}
	});
});

describe("composeWorkReads", () => {
	it("answers work reads from the source, leaves the base unmutated, and keeps base methods bound to the base", async () => {
		const base = new MockConsoleClient({ delayMs: 1 });
		const own = base.listWork;
		const c = composeWorkReads(base, { listWork: async () => ({ items: [] }), getWorkRecord: undefined });
		assert.deepEqual(await c.listWork!("w", { domain: "wolfpack" }), { items: [] });
		assert.equal(c.getWorkRecord, undefined);
		assert.equal(base.listWork, own);
		assert.equal((await base.listWork!("w", { domain: "wolfpack" })).items.length > 0, true);
		assert.equal((await c.listWolves()).length, 1);
	});
});
