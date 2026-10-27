import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityWolves, createPulseBatcher, pulseTargets } from "../src/core/graph-activity.ts";
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
	});
});
