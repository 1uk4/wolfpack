import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { emptyKbLife, KB_WAIT_MAX_MS, kbPendingCount, reduceKbLife, stepKbLife, syncPendingKb, type KbLife } from "../../../src/core/index.ts";

const T0 = 1_000_000;
let n = 0;
const ev = (verb: string, over: Partial<ActivityEvent>): ActivityEvent => ({ v: 1, id: `o${n++}`, pack: "p", ts: 0, ttlMs: 60_000, actor: { kind: "wolf", wolf: "1uk4" }, verb, ...over }) as ActivityEvent;
const hub = { kind: "hub", title: "curator" } as const;
const promote = (topic: string) => ev("memory-promote", { target: { kind: "domain", id: "wolfpack" }, detail: { ref: `c-${topic}`, topicIds: [topic] } });
const start = (topic: string) => ev("curate-start", { actor: hub, detail: { ref: topic, topicIds: [topic] } });
const done = (topic: string, outcome: string, extra: Partial<ActivityEvent> = {}) => ev("curate-done", { actor: hub, detail: { outcome, ref: topic, section: "memory" }, ...extra });
const feed = (events: ActivityEvent[]): KbLife => events.reduce((s, e) => reduceKbLife(s, e, T0), emptyKbLife(T0));

describe("kb orbit (work-wolfpack-W24l0C6)", () => {
	it("promote -> flies to Home and orbits -> curate-start -> curate-done files it with the tree path", () => {
		let s = stepKbLife(feed([promote("t1")]), T0);
		assert.equal(s.flights[0]!.stage, "travel");
		s = stepKbLife(s, T0 + 5000);
		assert.equal(s.flights[0]!.stage, "wait");
		assert.equal(kbPendingCount(s), 1);
		s = reduceKbLife(s, start("t1"), T0 + 6000);
		assert.deepEqual(Object.keys(s.curator), ["t1"]);
		assert.equal(kbPendingCount(s), 1); // still queued until filed
		s = reduceKbLife(s, done("t1", "create", { target: { kind: "kb-entry", id: "e1", domain: "wolfpack" }, detail: { outcome: "create", ref: "t1", section: "memory", sectionPath: ["a", "memory"] } }), T0 + 7000);
		s = stepKbLife(s, T0 + 7000);
		assert.equal(s.flights[0]!.stage, "place");
		s = stepKbLife(s, T0 + 10_000);
		assert.deepEqual(s.pulses.map((p) => [p.entryId, p.sectionPath]), [["e1", ["a", "memory"]]]);
		assert.equal(kbPendingCount(s), 0);
	});

	it("items pending when the graph opens orbit Home at once, never time out, and drop out when the hub no longer lists them", () => {
		let s = syncPendingKb(emptyKbLife(T0), [{ wolf: "1uk4", denTopicId: "p1", domain: "wolfpack" }, { wolf: "1uk4", denTopicId: "p2" }], T0);
		assert.deepEqual(s.flights.map((f) => [f.id, f.stage, f.wolf]), [["p1", "wait", "1uk4"], ["p2", "wait", "1uk4"]]);
		assert.equal(kbPendingCount(s), 2);
		s = stepKbLife(s, T0 + 5 * KB_WAIT_MAX_MS);
		assert.equal(s.flights.length, 2);
		s = syncPendingKb(s, [{ wolf: "1uk4", denTopicId: "p2" }], T0 + 1);
		assert.deepEqual(s.flights.map((f) => f.id), ["p2"]);
		s = reduceKbLife(s, done("p2", "merge"), T0 + 2);
		assert.equal(s.flights[0]!.result?.outcome, "merge"); // curate-done finds the seeded item
	});

	it("a work-record save flies to the feature node and ends there; it never waits at Home", () => {
		let s = feed([ev("memory-promote", { target: { kind: "domain", id: "wolfpack" }, detail: { ref: "c-w1", kind: "work", workItem: "work-wolfpack-DFJ8JHk" } })]);
		assert.deepEqual([s.flights[0]!.kind, s.flights[0]!.workItem], ["work", "work-wolfpack-DFJ8JHk"]);
		s = stepKbLife(stepKbLife(s, T0), T0 + 5000);
		assert.equal(s.flights[0]!.stage, "fade");
		s = stepKbLife(s, T0 + 20_000);
		assert.deepEqual([s.flights.length, s.pulses.length], [0, 0]);
	});

	it("a graduation starts at the feature node, is marked graduated, and is filed like any entry", () => {
		let s = feed([ev("memory-promote", { actor: hub, target: { kind: "domain", id: "wolfpack" }, detail: { ref: "g1", topicIds: ["g1"], kind: "graduation", workItem: "work-wolfpack-DFJ8JHk" } })]);
		const f = s.flights[0]!;
		assert.deepEqual([f.graduated, f.workItem, f.domain], [true, "work-wolfpack-DFJ8JHk", "wolfpack"]);
		s = reduceKbLife(s, done("g1", "create"), T0 + 1);
		assert.equal(s.flights[0]!.result?.outcome, "create");
	});
});
