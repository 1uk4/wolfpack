import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { acquireLiveFeed, getLiveSnapshot, subscribeLive } from "../../components/graph/live/live-store.ts";

const g = globalThis as unknown as Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (i: number) =>
	`data: ${JSON.stringify({ type: "pack.activity", event: { v: 1, id: `e${i}`, pack: "p", ts: 0, ttlMs: 60_000, actor: { kind: "wolf", wolf: "hal" }, verb: "kb-read", target: { kind: "kb-entry", id: `k${i}` } } })}\n\n`;

describe("live store", () => {
	afterEach(() => {
		delete g.document;
		delete g.fetch;
	});

	it("tells subscribers about a burst of events once, not once per event, while the snapshot holds every event", async () => {
		g.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
		g.fetch = async (u: string) => {
			if (u.endsWith("presence")) return new Response(JSON.stringify({ v: 1, pack: "p", at: 0, wolves: [], threads: [], subagents: [], owner: [] }), { status: 200 });
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode(frame(i)));
				},
			});
			return new Response(body, { status: 200 });
		};
		let notified = 0;
		const off = subscribeLive(() => notified++);
		const release = acquireLiveFeed();
		await sleep(60);
		assert.equal(getLiveSnapshot().recent.length, 20, "no event is lost");
		assert.ok(notified <= 3, `subscribers notified ${notified} times for 20 events`);
		await sleep(250);
		assert.ok(notified <= 3, `still coalesced after the trailing flush: ${notified}`);
		release();
		off();
	});
});
