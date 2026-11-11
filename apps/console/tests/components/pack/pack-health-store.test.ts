/** work-wolfpack-6imFEq7: the pack-health store keeps one stream open while anything needs it, the open modal included. */
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

const { subscribePackHealth, openPackHealth, closePackHealth } = await import("../../../components/pack/pack-health-store.ts");
const openStreams = () => FakeEventSource.all.filter((s) => !s.closed).length;

describe("pack health store", () => {
	it("the open modal keeps the stream alive after every bar unmounts, and closing it stops the stream", () => {
		const unBar1 = subscribePackHealth(() => {});
		const unBar2 = subscribePackHealth(() => {});
		assert.equal(openStreams(), 1);
		openPackHealth(null);
		unBar1();
		unBar2();
		assert.equal(openStreams(), 1);
		closePackHealth();
		assert.equal(openStreams(), 0);
	});
});
