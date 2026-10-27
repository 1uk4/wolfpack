import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryHub, type MemorySource } from "../components/memory-events.tsx";

class FakeSource implements MemorySource {
	closed = false;
	open = () => {};
	msg = (_d: string) => {};
	err = (_closed: boolean) => {};
	close() {
		this.closed = true;
	}
	onOpen(cb: () => void) {
		this.open = cb;
	}
	onMessage(cb: (d: string) => void) {
		this.msg = cb;
	}
	onError(cb: (c: boolean) => void) {
		this.err = cb;
	}
}

function setup() {
	const sources: FakeSource[] = [];
	let t = 1000;
	const hub = createMemoryHub(
		() => {
			const s = new FakeSource();
			sources.push(s);
			return s;
		},
		{ baseMs: 5, maxMs: 20, now: () => t },
	);
	return { hub, sources, tick: (ms: number) => (t += ms) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = JSON.stringify({ type: "sweep_started", wolf: "w" });

describe("memory hub", () => {
	it("ref-counts one source per wolf and closes on the last unsubscribe", () => {
		const { hub, sources } = setup();
		const got: string[] = [];
		const off1 = hub.subscribe("w", (e) => got.push(e.type));
		const off2 = hub.subscribe("w", () => {});
		assert.equal(sources.length, 1);
		sources[0]!.msg(frame);
		sources[0]!.msg("garbage");
		assert.deepEqual(got, ["sweep_started"]);
		off1();
		assert.equal(sources[0]!.closed, false);
		off2();
		assert.equal(sources[0]!.closed, true);
		assert.equal(hub.size(), 0);
	});

	it("fires resync on re-open, not the first open", () => {
		const { hub, sources } = setup();
		let n = 0;
		hub.subscribe("w", () => {}, () => n++);
		sources[0]!.open();
		assert.equal(n, 0);
		sources[0]!.open();
		assert.equal(n, 1);
	});

	it("backs off and reopens after a terminal error", async () => {
		const { hub, sources } = setup();
		hub.subscribe("w", () => {});
		sources[0]!.err(true);
		assert.equal(sources[0]!.closed, true);
		assert.equal(sources.length, 1, "not reopened immediately");
		await sleep(30);
		assert.equal(sources.length, 2);
		sources[1]!.err(true);
		await sleep(2);
		assert.equal(sources.length, 2, "second delay is longer");
		await sleep(30);
		assert.equal(sources.length, 3);
	});

	it("treats rapid open→error flaps as closed and backs off", () => {
		const { hub, sources } = setup();
		hub.subscribe("w", () => {});
		sources[0]!.open();
		sources[0]!.err(false);
		assert.equal(sources[0]!.closed, false, "first flap: EventSource keeps retrying");
		sources[0]!.open();
		sources[0]!.err(false);
		assert.equal(sources[0]!.closed, true, "second flap: we take over with backoff");
	});

	it("does not reopen after the last subscriber left", async () => {
		const { hub, sources } = setup();
		const off = hub.subscribe("w", () => {});
		sources[0]!.err(true);
		off();
		await sleep(30);
		assert.equal(sources.length, 1);
	});
});
