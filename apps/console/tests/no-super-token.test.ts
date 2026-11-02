/** P2: the console's own hub token (WOLFPACK_HUB_TOKEN) never stands in for a browser that sent no token. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createThreadApi } from "../src/server/thread-api.ts";
import { createMemoryApi } from "../src/server/memory-api.ts";
import { createConsoleClient, hubHealth, makeRequestToken } from "../src/server/console-client.ts";

const startHub = async () => {
	const seen: string[] = [];
	const hub = createServer((req, res) => {
		seen.push(`${req.url} ${req.headers.authorization}`);
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ wolves: [], threads: [], items: [] }));
	});
	await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
	return { hub, seen, url: `http://127.0.0.1:${(hub.address() as AddressInfo).port}` };
};

describe("no browser token = 401, never the console's own token", () => {
	it("plain route, stream route and work route all answer 401 + hub-auth marker; the hub sees no request", async () => {
		const { hub, seen, url } = await startHub();
		try {
			const env = { WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "console-own-token", WOLFPACK_HUB_RELAY: "1" };
			// a request scope whose headers carry no Authorization (what the server sees from an unpaired browser)
			const client = createConsoleClient(env, makeRequestToken(async () => new Headers()));
			const threads = createThreadApi(() => client);
			const plain = await threads.wolves();
			assert.equal(plain.status, 401);
			assert.equal(plain.headers.get("x-wolfpack-hub-auth"), "required");
			await assert.rejects(async () => {
				for await (const _ of client.watch("alpha/home")) void _;
			}, (e: Error & { hubAuth?: boolean }) => e.hubAuth === true);
			const work = await createMemoryApi(() => client).workList("alpha", "wolfpack", false);
			assert.equal(work.status, 401);
			assert.equal(work.headers.get("x-wolfpack-hub-auth"), "required");
			// ...and outside any request scope too (a background job): still no fallback
			const bg = createConsoleClient(env, makeRequestToken(async () => { throw new Error("headers was called outside a request scope"); }));
			await assert.rejects(bg.listThreads("alpha"), (e: Error & { hubAuth?: boolean }) => e.hubAuth === true);
			assert.deepEqual(seen, []);
			// a browser token IS forwarded verbatim, and only it
			const paired = createConsoleClient(env, makeRequestToken(async () => new Headers({ authorization: "Bearer browser-tok" })));
			await paired.listThreads("alpha");
			assert.deepEqual(seen, ["/v1/wolves/alpha/threads Bearer browser-tok"]);
		} finally {
			hub.closeAllConnections();
			hub.close();
		}
	});

	it("hubHealth is the one caller of the console's own token", async () => {
		const { hub, seen, url } = await startHub();
		try {
			assert.deepEqual(await hubHealth({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: "console-own-token" }), { ok: true, status: 200 });
			assert.deepEqual(seen, ["/v1/wolves Bearer console-own-token"]);
			assert.equal((await hubHealth({})).ok, false);
		} finally {
			hub.closeAllConnections();
			hub.close();
		}
	});
});
