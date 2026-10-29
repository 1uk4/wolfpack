/** The console client factory: env decides mock vs wolf, and whether work reads come from a hub. */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { HttpConsoleClient, MockConsoleClient } from "@wolfpack/client";
import { createConsoleClient } from "../src/server/console-client.ts";

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
