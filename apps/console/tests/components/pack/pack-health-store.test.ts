/** work-wolfpack-6imFEq7: the pack-health store keeps one stream open while anything needs it, the open Pack page included. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

class FakeEventSource {
	static all: FakeEventSource[] = [];
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(readonly url: string) {
		FakeEventSource.all.push(this);
	}
	close() {
		this.closed = true;
	}
}
const g = globalThis as Record<string, unknown>;
g.EventSource = FakeEventSource;
g.window = { setTimeout: () => 0, clearTimeout: () => {} }; // inert timers: no stall fallback during the test

const { subscribePackHealth, holdPackHealth, getPackHealth } = await import("../../../components/pack/pack-health-store.ts");
const openStreams = () => FakeEventSource.all.filter((s) => !s.closed).length;

describe("pack health store", () => {
	it("the held Pack page keeps the stream alive after every bar unmounts, and releasing it stops the stream", () => {
		const unBar1 = subscribePackHealth(() => {});
		const unBar2 = subscribePackHealth(() => {});
		assert.equal(openStreams(), 1);
		const release = holdPackHealth();
		assert.equal(getPackHealth().held, true);
		unBar1();
		unBar2();
		assert.equal(openStreams(), 1);
		release();
		assert.equal(getPackHealth().held, false);
		assert.equal(openStreams(), 0);
	});

	it("releasing one of two holds keeps the page held until the last release", () => {
		const a = holdPackHealth();
		const b = holdPackHealth();
		a();
		assert.equal(getPackHealth().held, true);
		b();
		assert.equal(getPackHealth().held, false);
	});
});
