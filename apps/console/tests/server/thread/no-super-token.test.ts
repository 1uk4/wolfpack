/** P2: the console's own hub token (WOLFPACK_HUB_TOKEN) never stands in for a browser that sent no token. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createThreadApi } from "../../../src/server/thread/thread-api.ts";
import { createMemoryApi } from "../../../src/server/kb/memory-api.ts";
import { createConsoleClient, makeRequestToken } from "../../../src/server/thread/console-client.ts";

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

const OWN = "console-own-token";
const MODES: [string, (url: string, wolf: string) => Record<string, string>][] = [
	["relay=1", (url) => ({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: OWN, WOLFPACK_HUB_RELAY: "1" })],
	["relay=0", (url) => ({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: OWN, WOLFPACK_HUB_RELAY: "0" })],
	["WOLFPACK_API_URL + hub", (url, wolf) => ({ WOLFPACK_API_URL: wolf, WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: OWN })],
	["hub-only mock", (url) => ({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: OWN, WOLFPACK_HUB_RELAY: "0" })],
];
const noScope = async () => { throw new Error("headers was called outside a request scope"); };

describe("no browser token = 401, never the console's own token", () => {
	for (const [label, mkEnv] of MODES) {
		it(`${label}: no token (scope without Authorization, or no scope) never puts the console token on the wire`, async () => {
			const hubS = await startHub();
			const wolfS = await startHub();
			try {
				const env = mkEnv(hubS.url, wolfS.url);
				for (const resolver of [makeRequestToken(async () => new Headers()), makeRequestToken(noScope)]) {
					const client = createConsoleClient(env, resolver);
					const calls: Promise<unknown>[] = [
						client.listWolves(), client.listThreads("alpha"), client.listWork?.("alpha", { domain: "wolfpack" }) ?? Promise.resolve(),
						client.getWorkRecord?.("alpha", "work-wolfpack-x") ?? Promise.resolve(),
						client.claimWork?.("work-wolfpack-x") ?? Promise.resolve(), client.releaseWork?.("work-wolfpack-x") ?? Promise.resolve(),
						(async () => { for await (const _ of client.watch("alpha/home")) void _; })(),
					];
					await Promise.allSettled(calls);
				}
				for (const seen of [hubS.seen, wolfS.seen]) assert.equal(seen.filter((x) => x.includes(OWN)).length, 0, `${label}: ${seen.join(" | ")}`);
			} finally {
				for (const h of [hubS.hub, wolfS.hub]) { h.closeAllConnections(); h.close(); }
			}
		});
	}

	it("relay: plain route, stream route and work route all answer 401 + hub-auth marker; the hub sees no request; a browser token is forwarded verbatim", async () => {
		const { hub, seen, url } = await startHub();
		try {
			const env = { WOLFPACK_HUB_URL: url, WOLFPACK_HUB_TOKEN: OWN, WOLFPACK_HUB_RELAY: "1" };
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
			const bg = createConsoleClient(env, makeRequestToken(noScope));
			await assert.rejects(bg.listThreads("alpha"), (e: Error & { hubAuth?: boolean }) => e.hubAuth === true);
			assert.deepEqual(seen, []);
			const paired = createConsoleClient(env, makeRequestToken(async () => new Headers({ authorization: "Bearer browser-tok" })));
			await paired.listThreads("alpha");
			assert.deepEqual(seen, ["/v1/wolves/alpha/threads Bearer browser-tok"]);
		} finally {
			hub.closeAllConnections();
			hub.close();
		}
	});
});
