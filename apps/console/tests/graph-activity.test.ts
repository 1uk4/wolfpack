import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityWolves, createDebounce, createPendingPulses, createPulseBatcher, eventNodeIds, pulseTargets } from "../src/core/graph-activity.ts";
import type { MemoryEventFrame } from "../src/core/kb.ts";

const ids = ["work:w1", "den:ada:t1", "ent:e1", "den:bob:t2"];
const graph = { nodes: ids.map((id) => ({ id })) } as never;
const ev = (o: Record<string, unknown>) => ({ wolf: "ada", domain: "d", timestamp: "t", ...o }) as unknown as MemoryEventFrame;

describe("pulseTargets", () => {
	it("observation_captured: work target / den topic", () => {
		assert.deepEqual(pulseTargets(ev({ type: "observation_captured", target: { kind: "work", workId: "w1" } }), graph), ["work:w1"]);
		assert.deepEqual(pulseTargets(ev({ type: "observation_captured", target: { kind: "den", topicId: "t1" } }), graph), ["den:ada:t1"]);
		assert.deepEqual(pulseTargets(ev({ type: "observation_captured", target: { kind: "session" } }), graph), []);
	});
	it("record_written", () => {
		assert.deepEqual(pulseTargets(ev({ type: "record_written", target: { kind: "work", workId: "w1" } }), graph), ["work:w1"]);
	});
	it("topic_archived: entry and den topic", () => {
		const e = ev({ type: "topic_archived", topicId: "t1", absorbedInto: "e1", target: { kind: "den", topicId: "t1" } });
		assert.deepEqual(pulseTargets(e, graph), ["ent:e1", "den:ada:t1"]);
	});
	it("sweep_item: entry and the contributor's den topic", () => {
		const e = ev({ type: "sweep_item", from: "bob", denTopicId: "t2", outcome: "create", entryId: "e1", wolf: "librarian" });
		assert.deepEqual(pulseTargets(e, graph), ["ent:e1", "den:bob:t2"]);
		assert.deepEqual(pulseTargets(ev({ type: "sweep_item", from: "bob", denTopicId: "t2", outcome: "reject" }), graph), ["den:bob:t2"]);
	});
	it("topic_consolidated names its den topic", () => {
		assert.deepEqual(pulseTargets(ev({ type: "topic_consolidated", topicId: "t1", target: { kind: "den" } }), graph), ["den:ada:t1"]);
	});
	it("ids not in the graph are dropped; unknown/null → []", () => {
		assert.deepEqual(pulseTargets(ev({ type: "record_written", target: { kind: "work", workId: "nope" } }), graph), []);
		assert.deepEqual(pulseTargets(ev({ type: "mystery", entryId: "e1" }), graph), []);
		assert.deepEqual(pulseTargets(ev({ type: "sweep_started" }), graph), []);
		assert.deepEqual(pulseTargets(ev({ type: "record_written", target: { kind: "work", workId: "w1" } }), null), []);
	});
});

describe("createPulseBatcher", () => {
	it("coalesces a burst into one de-duplicated flush", () => {
		const pending: (() => void)[] = [];
		const out: string[][] = [];
		const b = createPulseBatcher((i) => out.push(i), 100, { set: (fn) => (pending.push(fn), pending.length), clear: () => pending.pop() });
		b.add(["a", "b"]);
		b.add(["b", "c"]);
		b.add([]);
		assert.equal(pending.length, 1);
		pending[0]!();
		assert.deepEqual(out, [["a", "b", "c"]]);
	});
	it("cancel drops pending ids", () => {
		const pending: (() => void)[] = [];
		const out: string[][] = [];
		const b = createPulseBatcher((i) => out.push(i), 100, { set: (fn) => (pending.push(fn), 1), clear: () => pending.pop() });
		b.add(["a"]);
		b.cancel();
		assert.equal(pending.length, 0);
		assert.deepEqual(out, []);
	});
});

describe("activityWolves", () => {
	it("librarian first, online only, capped, no dupes", () => {
		const w = [
			{ name: "ada", status: "online" },
			{ name: "lib", status: "online" },
			{ name: "off", status: "offline" },
			{ name: "bob", status: "online" },
		];
		assert.deepEqual(activityWolves("lib", w), ["lib", "ada", "bob"]);
		assert.deepEqual(activityWolves("lib", w, 2), ["lib", "ada"]);
		assert.deepEqual(activityWolves(null, [{ name: "1uk4", status: "busy" }]), ["1uk4"]);
		const many = Array.from({ length: 9 }, (_, i) => ({ name: `w${i}`, status: "online" }));
		assert.deepEqual(activityWolves("lib", many), ["lib", "w0", "w1", "w2", "w3"]);
	});
});

describe("eventNodeIds", () => {
	it("names nodes the graph may not have yet", () => {
		assert.deepEqual(eventNodeIds(ev({ type: "sweep_item", from: "bob", denTopicId: "t9", outcome: "create", entryId: "new" })), ["ent:new", "den:bob:t9"]);
		assert.deepEqual(eventNodeIds(ev({ type: "mystery" })), []);
	});
});

describe("createPendingPulses", () => {
	const g = (...i: string[]) => ({ nodes: i.map((id) => ({ id })) }) as never;
	it("hands out ids once the graph has them, then forgets them", () => {
		const p = createPendingPulses(1000);
		p.add(["ent:new", "ent:other"], 0);
		assert.deepEqual(p.take(g("ent:x"), 10), []);
		assert.deepEqual(p.take(g("ent:new"), 20), ["ent:new"]);
		assert.deepEqual(p.take(g("ent:new"), 30), []);
		assert.equal(p.size(), 1);
	});
	it("expires after the TTL", () => {
		const p = createPendingPulses(1000);
		p.add(["ent:new"], 0);
		assert.deepEqual(p.take(g("ent:new"), 1000), []);
		assert.equal(p.size(), 0);
	});
	it("is bounded, dropping the oldest", () => {
		const p = createPendingPulses(1000, 2);
		p.add(["a", "b", "c"], 0);
		assert.deepEqual(p.take(g("a", "b", "c"), 1), ["b", "c"]);
	});
});

describe("createDebounce", () => {
	it("restarts on each call and fires once", () => {
		let fn: (() => void) | null = null;
		let cleared = 0;
		let fired = 0;
		const d = createDebounce(() => fired++, 100, { set: (f) => ((fn = f), 1), clear: () => cleared++ });
		d.call();
		d.call();
		assert.equal(cleared, 1);
		fn!();
		assert.equal(fired, 1);
		d.cancel();
		assert.equal(cleared, 1);
	});
});
