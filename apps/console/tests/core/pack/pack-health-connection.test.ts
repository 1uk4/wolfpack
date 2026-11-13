import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHealthConnection, type EventSourceLike, type HealthConnectionDeps } from "../../../src/core/pack/pack-health-connection.ts";

/** Fake clock, EventSource and fetch: the system boundaries the connection is given. */
function harness(opts: { eventSource?: boolean; fetch?: "ok" | "fail" | "manual" } = {}) {
	let now = 0;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const streams: (EventSourceLike & { closed: boolean; openedAt: number })[] = [];
	const fetches: { at: number; signal: AbortSignal; settle: (ok: boolean) => void }[] = [];
	const snapshots: number[] = [];
	let unreachable = 0;
	const snap = { checkedAt: null, intervalMs: 5000, links: [] };
	class FakeEventSource implements EventSourceLike {
		onmessage: EventSourceLike["onmessage"] = null;
		onerror: EventSourceLike["onerror"] = null;
		closed = false;
		openedAt = now;
		constructor() {
			streams.push(this);
		}
		close() {
			this.closed = true;
		}
	}
	const deps: HealthConnectionDeps = {
		EventSource: opts.eventSource === false ? undefined : FakeEventSource,
		fetch: (_url, init) =>
			new Promise((resolve, reject) => {
				const settle = (ok: boolean) => (ok ? resolve({ ok: true, status: 200, json: async () => snap }) : reject(new Error("refused")));
				fetches.push({ at: now, signal: init.signal, settle });
				if (opts.fetch !== "manual") settle(opts.fetch !== "fail");
			}),
		setTimeout: (fn, ms) => {
			timers.set(++seq, { at: now + ms, fn });
			return seq;
		},
		clearTimeout: (t) => void timers.delete(t as number),
		onSnapshot: () => void snapshots.push(now),
		onUnreachable: () => void unreachable++,
	};
	const flush = async () => {
		for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	};
	const advance = async (ms: number) => {
		const end = now + ms;
		await flush();
		for (;;) {
			const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > end) break;
			timers.delete(next[0]);
			now = next[1].at;
			next[1].fn();
			await flush();
		}
		now = end;
	};
	return { deps, streams, fetches, snapshots, timers, advance, flush, get unreachable() { return unreachable; } };
}

describe("pack health connection", () => {
	it("backs off reopening a failing stream while polls succeed, and a stream frame resets the backoff", async () => {
		const h = harness();
		const c = createHealthConnection(h.deps);
		c.start();
		// The stream errors as soon as it opens, every time.
		const failEach = async (until: number) => {
			for (let t = 0; t < until; t += 500) {
				const last = h.streams[h.streams.length - 1]!;
				if (!last.closed) last.onerror?.();
				await h.advance(500);
			}
		};
		await failEach(80_000);
		assert.deepEqual(
			h.streams.map((s) => s.openedAt),
			[0, 5_000, 15_000, 35_000, 75_000],
		);
		// A frame on a fresh stream resets the wait to 5 s.
		await h.advance(55_000); // to 135 s: the next reopen, 75 s + the 60 s cap
		const s = h.streams[h.streams.length - 1]!;
		assert.equal(s.openedAt, 135_000);
		s.onmessage?.({ data: JSON.stringify({ checkedAt: null, intervalMs: 5000, links: [] }) });
		s.onerror?.();
		await h.advance(5_000);
		assert.equal(h.streams[h.streams.length - 1]!.openedAt, 140_000);
		c.stop();
	});

	it("only polls, at the snapshot interval, when there is no EventSource", async () => {
		const h = harness({ eventSource: false });
		const c = createHealthConnection(h.deps);
		c.start();
		await h.advance(12_000);
		assert.deepEqual(
			h.fetches.map((f) => f.at),
			[0, 5_000, 10_000],
		);
		assert.deepEqual(h.snapshots, [0, 5_000, 10_000]);
		c.stop();
	});

	it("keeps one poll chain when the stream fails again while a poll is in flight", async () => {
		const h = harness({ fetch: "manual" });
		const c = createHealthConnection(h.deps);
		c.start();
		h.streams[0]!.onerror?.();
		h.streams[0]!.onerror?.(); // a second error (or stall) during the in-flight fetch
		await h.flush();
		assert.equal(h.fetches.length, 1);
		h.fetches[0]!.settle(false);
		await h.advance(5_000);
		assert.equal(h.unreachable, 1);
		assert.deepEqual(
			h.fetches.map((f) => f.at),
			[0, 5_000],
		);
		c.stop();
	});

	it("stop closes the stream, aborts the in-flight poll and leaves no timer behind", async () => {
		const h = harness({ fetch: "manual" });
		const c = createHealthConnection(h.deps);
		c.start();
		h.streams[0]!.onerror?.();
		await h.flush();
		c.stop();
		assert.equal(h.streams[0]!.closed, true);
		assert.equal(h.fetches[0]!.signal.aborted, true);
		assert.equal(h.timers.size, 0);
		h.fetches[0]!.settle(true);
		await h.advance(120_000);
		assert.deepEqual(h.snapshots, []);
		assert.equal(h.unreachable, 0);
		assert.equal(h.streams.length, 1);
		assert.equal(h.fetches.length, 1);
	});
});
