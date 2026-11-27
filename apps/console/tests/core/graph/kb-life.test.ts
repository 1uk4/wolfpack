import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { addRow, displayFill, emptyKbLife, foldEvents, groupRows, mergeSeed, reduceKbLife, stepKbLife, type KbLife } from "../../../src/core/index.ts";

const T0 = 1_000_000;
let n = 0;
const ev = (verb: string, over: Partial<ActivityEvent>): ActivityEvent => ({ v: 1, id: `e${n++}`, pack: "p", ts: 0, ttlMs: 60_000, actor: { kind: "wolf", wolf: "1uk4" }, verb, ...over }) as ActivityEvent;
const observe = (count: number) => ev("memory-observe", { detail: { count, capacity: 40_000 } });
const consolidate = (...topicIds: string[]) => ev("memory-consolidate", { detail: { count: 12, topicIds } });
const promote = (topic: string, domain = "wolfpack") => ev("memory-promote", { target: { kind: "domain", id: domain }, detail: { ref: `c-${topic}`, topicIds: [topic] } });
const start = (topic: string) => ev("curate-start", { actor: { kind: "hub", title: "curator" }, detail: { ref: topic, topicIds: [topic] } });
const done = (topic: string, outcome: string, extra: Partial<ActivityEvent> = {}) =>
	ev("curate-done", { actor: { kind: "hub", title: "curator" }, detail: { outcome, ref: topic, section: "memory", sectionTitle: "Memory", ms: 900 }, ...extra });
const feed = (events: ActivityEvent[], now = T0, reduced = false): KbLife => events.reduce((s, e) => reduceKbLife(s, e, now), emptyKbLife(now, reduced));

describe("kb life model", () => {
	it("fills a wolf's buffer ring as count over capacity and eases it from the old value", () => {
		const s = feed([observe(10_000)]);
		assert.equal(s.wolves["1uk4"]!.fill, 0.25);
		const s2 = reduceKbLife(s, observe(30_000), T0 + 1000);
		assert.equal(displayFill(s2.wolves["1uk4"]!, T0 + 1000), 0.25); // starts where it was
		assert.equal(displayFill(s2.wolves["1uk4"]!, T0 + 5000), 0.75);
	});

	it("consolidate empties the ring into topic dots beside the wolf; promote takes a dot and queues a flight", () => {
		let s = feed([observe(20_000), consolidate("t1", "t2")]);
		assert.equal(s.wolves["1uk4"]!.fill, 0);
		assert.deepEqual(s.topics.map((t) => t.id), ["t1", "t2"]);
		s = reduceKbLife(s, promote("t1"), T0);
		assert.deepEqual(s.topics.map((t) => t.id), ["t2"]);
		assert.deepEqual(s.flights.map((f) => [f.id, f.stage, f.domain]), [["t1", "queued", "wolfpack"]]);
	});

	it("paces a burst: flights start 900 ms apart, at most 6 at once, and none is dropped", () => {
		let s = feed(Array.from({ length: 10 }, (_, i) => promote(`t${i}`)));
		s = stepKbLife(s, T0);
		assert.deepEqual(s.flights.map((f) => f.stage), ["travel", ...Array(9).fill("queued")]);
		s = stepKbLife(s, T0 + 900);
		assert.equal(s.flights.filter((f) => f.stage === "travel").length, 2);
		for (let t = 1800; t <= 4500; t += 900) s = stepKbLife(s, T0 + t);
		assert.equal(s.flights.filter((f) => f.stage === "travel").length, 6);
		assert.equal(s.flights.length, 10);
	});

	it("a topic travels 5 s to the curator, waits there, and a create floats to its section and leaves a pulse", () => {
		let s = stepKbLife(feed([promote("t1")]), T0);
		s = stepKbLife(s, T0 + 4999);
		assert.equal(s.flights[0]!.stage, "travel");
		s = stepKbLife(s, T0 + 5000);
		assert.equal(s.flights[0]!.stage, "wait");
		s = reduceKbLife(reduceKbLife(s, start("t1"), T0 + 5100), done("t1", "create", { target: { kind: "kb-entry", id: "kb-x", domain: "wolfpack" } }), T0 + 6000);
		assert.deepEqual(Object.keys(s.curator), []);
		s = stepKbLife(s, T0 + 6000);
		assert.equal(s.flights[0]!.stage, "place");
		s = stepKbLife(s, T0 + 9000);
		assert.equal(s.flights.length, 0);
		assert.deepEqual(s.pulses.map((p) => [p.kind, p.entryId]), [["create", "kb-x"]]);
		assert.equal(stepKbLife(s, T0 + 9000 + 2600).pulses.length, 0);
	});

	it("a result that arrives while the topic is still flying is held until it reaches the curator", () => {
		let s = stepKbLife(feed([promote("t1")]), T0);
		s = reduceKbLife(s, done("t1", "merge", { target: { kind: "kb-entry", id: "kb-y", domain: "wolfpack" } }), T0 + 1000);
		s = stepKbLife(s, T0 + 2000);
		assert.equal(s.flights[0]!.stage, "travel");
		s = stepKbLife(s, T0 + 5000);
		assert.equal(s.flights[0]!.stage, "place");
	});

	it("reject and parked fade at the curator with no pulse; the reason is kept for the details", () => {
		let s = stepKbLife(feed([promote("t1")]), T0);
		s = stepKbLife(s, T0 + 5000);
		s = reduceKbLife(s, done("t1", "reject", { detail: { outcome: "reject", ref: "t1", reason: "duplicate" } }), T0 + 5000);
		s = stepKbLife(s, T0 + 5000);
		assert.deepEqual([s.flights[0]!.stage, s.flights[0]!.result?.reason], ["fade", "duplicate"]);
		s = stepKbLife(s, T0 + 7000);
		assert.deepEqual([s.flights.length, s.pulses.length], [0, 0]);
	});

	it("a curate-done with no promote seen still lands its result", () => {
		let s = feed([done("tx", "merge", { target: { kind: "kb-entry", id: "kb-z", domain: "snapjack" } })]);
		s = stepKbLife(stepKbLife(s, T0), T0 + 3000);
		assert.deepEqual(s.pulses.map((p) => [p.kind, p.domain]), [["merge", "snapjack"]]);
	});

	it("reduced motion: no flight time, the result lands at once", () => {
		let s = feed([promote("t1")], T0, true);
		s = stepKbLife(s, T0);
		assert.equal(s.flights[0]!.stage, "wait");
		s = reduceKbLife(s, done("t1", "merge", { target: { kind: "kb-entry", id: "kb-y" } }), T0);
		s = stepKbLife(stepKbLife(s, T0), T0);
		assert.deepEqual([s.flights.length, s.pulses.length], [0, 1]);
	});
});

describe("kb life log", () => {
	const at = (e: ActivityEvent, ms: number) => ({ event: e, at: T0 + ms });
	it("folds repeats of the same step on the same target within a minute into one row with a count", () => {
		const target = { kind: "kb-entry", id: "kb-x", domain: "wolfpack", title: "Zod standard" };
		const rows = foldEvents([at(done("t1", "merge", { target }), 0), at(done("t2", "merge", { target }), 20_000), at(done("t3", "merge", { target }), 200_000), at(observe(1), 0), at(observe(2), 3000)]);
		assert.deepEqual(rows.map((r) => [r.verb, r.n]).sort(), [["merged", 1], ["merged", 2], ["observe", 2]]);
	});

	it("puts processing under the domain its promote named, wolves' own steps in a null group", () => {
		const rows = foldEvents([at(observe(1), 0), at(promote("t1", "snapjack"), 100), at(start("t1"), 200)]);
		const groups = groupRows(rows);
		assert.deepEqual(groups.map((g) => [g.domain, g.rows.map((r) => r.verb).sort()]).sort(), [["snapjack", ["processing", "promote"]], [null, ["observe"]]].sort());
	});

	it("carries ids, outcome, reason, tokens and ms on the row for the details", () => {
		const [r] = foldEvents([at(done("t1", "reject", { detail: { outcome: "reject", ref: "t1", reason: "dup", ms: 5, tokens: 77 } }), 0)]);
		assert.deepEqual([r!.verb, r!.reason, r!.tokens, r!.ms, r!.ids.includes("t1")], ["rejected", "dup", 77, 5, true]);
	});

	it("drops a history row the live feed already shows and keeps older ones, newest first", () => {
		const live = foldEvents([at(done("t1", "merge", { target: { kind: "kb-entry", id: "k", domain: "wolfpack", title: "A" } }), 0)]);
		const seed = (title: string, ms: number) => ({ ...live[0]!, key: title + ms, title, at: T0 + ms, firstAt: T0 + ms, fold: `merged|${title}`, seed: true as const });
		const rows = mergeSeed(live, [seed("A", -5000), seed("B", -999_999)]);
		assert.deepEqual(rows.map((r) => r.title), ["A", "B"]);
		assert.equal(addRow([], live[0]!).length, 1);
	});
});
