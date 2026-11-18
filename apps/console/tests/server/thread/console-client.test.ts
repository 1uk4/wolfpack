/** The console client factory: env decides mock vs wolf, and whether work reads come from a hub. */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { HttpConsoleClient, MockConsoleClient } from "@wolfpack/client";
import { composeWorkReads, createConsoleClient } from "../../../src/server/thread/console-client.ts";

describe("createConsoleClient", () => {
	it("defaults to the mock, or an HTTP client with WOLFPACK_API_URL", () => {
		assert.ok(createConsoleClient({}) instanceof MockConsoleClient);
		assert.ok(createConsoleClient({ WOLFPACK_API_URL: "http://127.0.0.1:1" }) instanceof HttpConsoleClient);
	});

	it("WOLFPACK_HUB_URL (+ WOLFPACK_HUB_TOKEN) points work reads at the hub", async () => {
		const seen: { url?: string; auth?: string; key?: string }[] = [];
		const hub = createServer((req, res) => {
			seen.push({ url: req.url, auth: String(req.headers.authorization), key: String(req.headers["x-api-key"]) });
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ items: [] }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
		try {
			for (const env of [{ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "k" }, { WOLFPACK_API_URL: "http://127.0.0.1:1", WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "k" }]) {
				seen.length = 0;
				const c = createConsoleClient(env);
				assert.deepEqual(await c.listWork!("1uk4", { domain: "wolfpack" }), { items: [] });
				assert.deepEqual(seen, [{ url: "/v1/work?domain=wolfpack", auth: "Bearer k", key: "undefined" }]);
			}
		} finally {
			hub.close();
		}
	});
});

describe("relay is the default with a hub + token and no direct wolf host", () => {
	it("defaults on; WOLFPACK_API_URL means direct; =0 turns it off; =1 forces it", async () => {
		const urls: string[] = [];
		const hub = createServer((req, res) => {
			urls.push(String(req.url));
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ threads: [] }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
		try {
			const base = { WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "t" };
			await createConsoleClient(base).listThreads("alpha");
			assert.deepEqual(urls, ["/v1/wolves/alpha/threads"]);
			urls.length = 0;
			await createConsoleClient({ ...base, WOLFPACK_HUB_RELAY: "1", WOLFPACK_API_URL: "http://127.0.0.1:1" }).listThreads("alpha");
			assert.deepEqual(urls, ["/v1/wolves/alpha/threads"]);
			// off: threads stay on the mock, work reads still use the hub
			urls.length = 0;
			await createConsoleClient({ ...base, WOLFPACK_HUB_RELAY: "0" }).listThreads("1uk4");
			assert.deepEqual(urls, [], "off: threads stay on the mock, nothing reaches the hub");
			// direct wolf configured: direct mode
			assert.ok(createConsoleClient({ ...base, WOLFPACK_API_URL: "http://127.0.0.1:1" }) instanceof HttpConsoleClient);
		} finally {
			hub.closeAllConnections();
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

describe("the removed WOLFPACK_HUB_KEY", () => {
	it("is ignored (no credentials sent) and logs a one-line warning", async () => {
		const seen: { auth?: string; key?: string }[] = [];
		const hub = createServer((req, res) => {
			seen.push({ auth: String(req.headers.authorization), key: String(req.headers["x-api-key"]) });
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ items: [] }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
		const warnings: string[] = [];
		const orig = console.warn;
		console.warn = (m: unknown) => void warnings.push(String(m));
		try {
			await createConsoleClient({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_KEY: "old-shared-key-0123456789" }).listWork!("1uk4", { domain: "wolfpack" }).catch(() => undefined);
		} finally {
			console.warn = orig;
			hub.close();
		}
		assert.deepEqual(seen, [{ auth: "undefined", key: "undefined" }]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /WOLFPACK_HUB_KEY is no longer supported/);
		assert.doesNotMatch(warnings[0] ?? "", /old-shared-key/);
	});
});
