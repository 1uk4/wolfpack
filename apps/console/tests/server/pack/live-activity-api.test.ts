import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLiveActivityApi, liveFrameTransform } from "../../../src/server/pack/live-activity-api.ts";

const env = { WOLFPACK_HUB_URL: "http://hub.test" };
const req = (extra: Record<string, string> = {}, signal?: AbortSignal) => new Request("http://c/api/activity/stream", { headers: { authorization: "Bearer t", ...extra }, ...(signal ? { signal } : {}) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(chunks: string[]): Promise<string> {
	const t = liveFrameTransform();
	const w = t.writable.getWriter();
	const out = new Response(t.readable).text();
	for (const c of chunks) await w.write(new TextEncoder().encode(c));
	await w.close();
	return out;
}

describe("live activity proxy", () => {
	it("aborts the hub request when no response headers arrive in time, and answers 503", async () => {
		let aborted = false;
		const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => ((aborted = true), rej(new Error("aborted")))))) as unknown as typeof fetch;
		const r = await createLiveActivityApi({ env, fetch: hang, connectTimeoutMs: 30 }).stream(req());
		assert.equal(r.status, 503);
		assert.equal(aborted, true);
	});

	it("does not cut a long stream once the headers have arrived", async () => {
		const f = (async () => new Response(new ReadableStream<Uint8Array>({ async start(c) { await sleep(120); c.enqueue(new TextEncoder().encode("data: {\"type\":\"resync\"}\n\n")); c.close(); } }), { status: 200 })) as unknown as typeof fetch;
		const r = await createLiveActivityApi({ env, fetch: f, connectTimeoutMs: 40 }).stream(req());
		assert.equal(r.status, 200);
		assert.equal(await r.text(), "data: {\"type\":\"resync\"}\n\n");
	});

	it("releases the hub connection when the browser disconnects, by abort or by cancelling the response body", async () => {
		const mk = () => {
			const st = { upstreamAborted: false, bodyCancelled: false };
			const f = (async (_u: string, init: RequestInit) => {
				init.signal?.addEventListener("abort", () => (st.upstreamAborted = true));
				return new Response(new ReadableStream<Uint8Array>({ start() {}, cancel() { st.bodyCancelled = true; } }), { status: 200 });
			}) as unknown as typeof fetch;
			return { st, f };
		};
		const a = mk();
		const ctl = new AbortController();
		await createLiveActivityApi({ env, fetch: a.f }).stream(req({}, ctl.signal));
		ctl.abort();
		await sleep(10);
		assert.equal(a.st.upstreamAborted, true);
		const b = mk();
		const r = await createLiveActivityApi({ env, fetch: b.f }).stream(req());
		await r.body!.cancel();
		await sleep(10);
		assert.equal(b.st.bodyCancelled, true);
	});

	it("cancels the hub body of a response it turns into 204, 401 or 502 instead of leaving it open", async () => {
		for (const status of [403, 401, 500]) {
			let cancelled = false;
			const f = (async () => new Response(new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } }), { status })) as unknown as typeof fetch;
			await createLiveActivityApi({ env, fetch: f }).stream(req());
			await sleep(5);
			assert.equal(cancelled, true, `status ${status}`);
		}
	});

	it("answers 502 for a hub 409 like any other hub error", async () => {
		const f = (async () => new Response(null, { status: 409 })) as unknown as typeof fetch;
		assert.equal((await createLiveActivityApi({ env, fetch: f }).stream(req())).status, 502);
	});

	it("after a runaway frame drops everything up to the next blank line, then resumes", async () => {
		const out = await run(["data: " + "x".repeat(1_100_000), ": junk tail\n\ndata: {\"type\":\"resync\"}\n\n"]);
		assert.equal(out, "data: {\"type\":\"resync\"}\n\n");
	});
});
