/**
 * The thread API handlers (what the /api/wolves route files wrap), driven
 * against the @wolfpack/client mock: the SSE endpoint replays with
 * Last-Event-ID, follows live, and ends at turn-end.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockConsoleClient, FIXTURE_THREAD } from "@wolfpack/client";
import { createThreadApi, resumeCursor } from "../src/server/thread-api.ts";
import { getConsoleClient, setConsoleClient } from "../src/server/console-client.ts";

const ref = { wolf: "1uk4", slug: "home" };

interface Frame {
	id?: number;
	data: string;
}

async function frames(res: Response): Promise<Frame[]> {
	const text = await res.text();
	return text
		.split("\n\n")
		.filter(Boolean)
		.map((chunk) => {
			const lines = chunk.split("\n");
			const id = lines.find((l) => l.startsWith("id: "));
			return { id: id ? Number(id.slice(4)) : undefined, data: lines.find((l) => l.startsWith("data: "))!.slice(6) };
		});
}

const stream = (api: ReturnType<typeof createThreadApi>, headers: Record<string, string> = {}, query = "") =>
	api.stream(ref, new Request(`http://t/stream${query}`, { headers }));

describe("thread API: SSE stream", () => {
	it("streams the scripted turn through turn-end, framed with event ids, then [DONE]", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const api = createThreadApi(() => client);
		await client.submit(FIXTURE_THREAD.id, "go");
		const res = await stream(api);
		assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
		const got = await frames(res);
		assert.equal(got.at(-1)!.data, "[DONE]");
		const events = got.slice(0, -1).map((f) => JSON.parse(f.data) as { id: number; type: string });
		assert.equal(events[0]!.type, "turn-start");
		assert.equal(events.at(-1)!.type, "turn-end");
		assert.deepEqual(got.slice(0, -1).map((f) => f.id), events.map((e) => e.id));
	});

	it("follows a live turn (attached before it ends)", async () => {
		const client = new MockConsoleClient({ delayMs: 5 });
		const api = createThreadApi(() => client);
		await client.submit(FIXTURE_THREAD.id, "go");
		const got = await frames(await stream(api)); // returns only when turn-end arrived
		assert.equal(JSON.parse(got.at(-2)!.data).type, "turn-end");
	});

	it("replays only id > Last-Event-ID", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const api = createThreadApi(() => client);
		await client.submit(FIXTURE_THREAD.id, "go");
		const all = (await frames(await stream(api))).slice(0, -1);
		const cut = all[3]!.id!;
		const resumed = (await frames(await stream(api, { "Last-Event-ID": String(cut) }))).slice(0, -1);
		assert.deepEqual(resumed.map((f) => f.id), all.filter((f) => f.id! > cut).map((f) => f.id));
		assert.ok(resumed.length > 0 && resumed[0]!.id === cut + 1);
	});

	it("resumes mid-turn: cut a live stream, reconnect with the last seen id, get the rest", async () => {
		const client = new MockConsoleClient({ delayMs: 5 });
		const api = createThreadApi(() => client);
		await client.submit(FIXTURE_THREAD.id, "go");
		const res = await stream(api);
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		const seen: number[] = [];
		let buf = "";
		while (seen.length < 3) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value);
			for (const m of buf.matchAll(/^id: (\d+)$/gm)) if (!seen.includes(Number(m[1]))) seen.push(Number(m[1]));
		}
		await reader.cancel(); // the connection drops
		const last = seen.at(-1)!;
		const rest = (await frames(await stream(api, { "Last-Event-ID": String(last) }))).slice(0, -1);
		assert.equal(rest[0]!.id, last + 1);
		assert.equal(JSON.parse(rest.at(-1)!.data).type, "turn-end");
		const ids = rest.map((f) => f.id!);
		assert.deepEqual(ids, ids.map((_, i) => last + 1 + i), "contiguous, no gaps or repeats");
	});

	it("an idle thread with nothing to replay ends immediately", async () => {
		const api = createThreadApi(() => new MockConsoleClient({ delayMs: 0 }));
		assert.deepEqual(await frames(await stream(api)), [{ id: undefined, data: "[DONE]" }]);
	});

	it("?from= is honoured; junk cursors are ignored", () => {
		assert.equal(resumeCursor(new Request("http://t/s?from=7")), 7);
		assert.equal(resumeCursor(new Request("http://t/s", { headers: { "last-event-id": "4" } })), 4);
		assert.equal(resumeCursor(new Request("http://t/s?from=abc")), undefined);
		assert.equal(resumeCursor(new Request("http://t/s?from=-1")), undefined);
		assert.equal(resumeCursor(new Request("http://t/s")), undefined);
	});

	it("404s an unknown thread or wolf", async () => {
		const api = createThreadApi(() => new MockConsoleClient({ delayMs: 0 }));
		assert.equal((await api.stream({ wolf: "1uk4", slug: "nope" }, new Request("http://t/s"))).status, 404);
		assert.equal((await api.stream({ wolf: "ghost", slug: "home" }, new Request("http://t/s"))).status, 404);
	});
});

describe("thread API: reads and commands", () => {
	it("lists wolves and threads, serves thread detail by slug", async () => {
		const api = createThreadApi(() => new MockConsoleClient({ delayMs: 0 }));
		assert.deepEqual(((await (await api.wolves()).json()) as { wolves: { name: string }[] }).wolves.map((w) => w.name), ["1uk4"]);
		assert.deepEqual(((await (await api.threads("1uk4")).json()) as { threads: { id: string }[] }).threads.map((t) => t.id), ["1uk4/home"]);
		const detail = (await (await api.thread(ref)).json()) as { id: string; busy: boolean };
		assert.equal(detail.id, "1uk4/home");
		assert.equal(detail.busy, false);
	});

	it("submit acks, rejects a second while busy (409), validates input; abort ends the turn", async () => {
		const client = new MockConsoleClient({ delayMs: 20 });
		const api = createThreadApi(() => client);
		const post = (body: unknown) =>
			api.submit(ref, new Request("http://t/submit", { method: "POST", body: JSON.stringify(body) }));
		assert.equal((await post({})).status, 400);
		const ack = await post({ input: "hi" });
		assert.equal(ack.status, 200);
		assert.equal(((await ack.json()) as { disposition: string }).disposition, "started");
		const busy = await post({ input: "again" });
		assert.equal(busy.status, 409);
		assert.equal(((await busy.json()) as { code: string }).code, "busy");
		assert.equal((await api.abort(ref)).status, 200);
		const got = await frames(await stream(api));
		assert.equal(JSON.parse(got.at(-2)!.data).reason, "aborted");
	});
});

describe("console client factory", () => {
	it("is a process singleton (a turn started in one request is visible to the next)", async () => {
		setConsoleClient(undefined);
		const a = getConsoleClient();
		assert.equal(getConsoleClient(), a);
		await a.submit(FIXTURE_THREAD.id, "go");
		assert.equal((await getConsoleClient().getThread(FIXTURE_THREAD.id)).busy, true);
		await a.abort(FIXTURE_THREAD.id);
		setConsoleClient(undefined);
	});
});

describe("error matching", () => {
  it("matches client errors by name, so duplicated module copies still map to 404/409", async () => {
    class NotFoundError extends Error { constructor() { super("x"); this.name = "NotFoundError"; } }
    class BusyError extends Error { constructor() { super("y"); this.name = "BusyError"; } }
    const foreign = {
      listThreads: async () => { throw new NotFoundError(); },
      submit: async () => { throw new BusyError(); },
      getThread: async () => { throw new NotFoundError(); },
    } as unknown as import("@wolfpack/client").ConsoleClient;
    const api = createThreadApi(() => foreign);
    assert.equal((await api.threads("w")).status, 404);
    const known = { ...foreign, listThreads: async () => [{ id: "1uk4/home" }] } as unknown as typeof foreign;
    const post = createThreadApi(() => known).submit(ref, new Request("http://t", { method: "POST", body: JSON.stringify({ input: "a" }) }));
    assert.equal((await post).status, 409);
  });
});
