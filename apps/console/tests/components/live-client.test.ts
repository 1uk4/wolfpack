import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createSseParser, startLiveFeed, type SseFrame } from "../../components/graph/live/live-client.ts";

describe("live feed SSE parser", () => {
	it("assembles frames split across chunks, keeps ids, skips keepalive comments", () => {
		const got: SseFrame[] = [];
		const push = createSseParser((f) => got.push(f));
		push(": ping\n\ndata: {\"type\":\"pack.act");
		push("ivity\"}\n\nid: b:3\ndata: {\"type\":\"resync\"}\n\n");
		assert.deepEqual(got, [{ id: undefined, data: '{"type":"pack.activity"}' }, { id: "b:3", data: '{"type":"resync"}' }]);
	});
});

describe("live feed connection policy", () => {
	const snapBody = JSON.stringify({ v: 1, at: 0, wolves: [], threads: [], subagents: [], owner: [] });
	const flush = async () => {
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	};
	const evFrame = (id: string) =>
		`data: ${JSON.stringify({ type: "pack.activity", event: { v: 1, id, pack: "p", ts: 0, ttlMs: 1000, actor: { kind: "thread", wolf: "hal" }, verb: "thread-active" } })}\n\n`;
	const streamOf = (chunks: string[], keepOpen?: { release: () => void }) => {
		let ctl!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				ctl = c;
				for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
				if (!keepOpen) c.close();
			},
		});
		if (keepOpen) keepOpen.release = () => ctl.close();
		return new Response(body, { status: 200 });
	};
	let calls: string[] = [];
	let stop: (() => void) | null = null;
	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout"] });
		calls = [];
		(globalThis as unknown as { document: unknown }).document = { hidden: false, addEventListener() {}, removeEventListener() {} };
	});
	afterEach(() => {
		stop?.();
		mock.timers.reset();
	});
	const start = (fetchImpl: typeof fetch, extra: { now?: () => number } = {}) => {
		const actions: string[] = [];
		stop = startLiveFeed({ dispatch: (a) => actions.push(a.type), fetchImpl, ...extra });
		return actions;
	};

	it("with no hub (presence 204) never opens the stream and retries only after 10 minutes", async () => {
		const f = (async (u: string) => {
			calls.push(u);
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;
		start(f);
		await flush();
		mock.timers.tick(9 * 60_000);
		await flush();
		assert.deepEqual(calls, ["/api/activity/presence"]);
		mock.timers.tick(61_000);
		await flush();
		assert.deepEqual(calls, ["/api/activity/presence", "/api/activity/presence"]);
	});

	it("a stream that only sends keepalive comments reconnects slowly and keeps backing off", async () => {
		const f = (async (u: string) => {
			calls.push(u);
			return u.endsWith("presence") ? new Response(snapBody, { status: 200 }) : streamOf([": connected\n\n"]);
		}) as unknown as typeof fetch;
		start(f);
		await flush();
		assert.equal(calls.length, 2);
		mock.timers.tick(29_000); // a healthy reconnect would already have happened (1 s)
		await flush();
		assert.equal(calls.length, 2);
		mock.timers.tick(1_000);
		await flush();
		assert.equal(calls.length, 4); // 30 s: the comment did not reset the backoff
		mock.timers.tick(59_000);
		await flush();
		assert.equal(calls.length, 4);
		mock.timers.tick(1_000);
		await flush();
		assert.equal(calls.length, 6); // 60 s next
	});

	it("a real event resets the backoff to a fast reconnect", async () => {
		const f = (async (u: string) => {
			calls.push(u);
			return u.endsWith("presence") ? new Response(snapBody, { status: 200 }) : streamOf([evFrame("a")]);
		}) as unknown as typeof fetch;
		start(f);
		await flush();
		mock.timers.tick(1_000);
		await flush();
		assert.equal(calls.length, 4);
	});

	it("a late snapshot after a resync does not overwrite fresher events", async () => {
		let t = 0;
		const rel = { release: () => {} };
		let presenceCalls = 0;
		let finishSnapshot!: () => void;
		const f = (async (u: string) => {
			if (u.endsWith("presence")) {
				if (++presenceCalls === 1) return new Response(snapBody, { status: 200 });
				await new Promise<void>((r) => (finishSnapshot = r));
				return new Response(snapBody, { status: 200 });
			}
			return streamOf(['data: {"type":"resync"}\n\n', evFrame("fresh")], rel);
		}) as unknown as typeof fetch;
		const actions = start(f, { now: () => ++t });
		await flush();
		finishSnapshot();
		await flush();
		assert.deepEqual(actions, ["snapshot", "resync", "event"]); // the second snapshot was dropped
		rel.release();
	});
});
