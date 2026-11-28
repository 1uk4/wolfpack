import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { KB_MAX_DOMAINS, KB_NERVE_GLOW_MS, KB_NERVE_MS, KB_PULSE_MS, kbNerveState, KB_MAX_QUEUE, KB_MAX_TOPICS_PER_WOLF, addRow, displayFill, emptyKbLife, foldEvents, groupRows, kbLifeBusy, mergeSeed, reduceKbLife, stepKbLife, withReasons, withTitles, type KbLife } from "../../../src/core/index.ts";

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
		s = reduceKbLife(reduceKbLife(s, start("t1"), T0 + 5100), done("t1", "create", { target: { kind: "kb-entry", id: "kb-x", domain: "wolfpack" }, detail: { outcome: "create", ref: "t1", section: "memory", sectionPath: ["top", "memory"] } }), T0 + 6000);
		assert.deepEqual(Object.keys(s.curator), []);
		s = stepKbLife(s, T0 + 6000);
		assert.equal(s.flights[0]!.stage, "place");
		s = stepKbLife(s, T0 + 9000);
		assert.equal(s.flights.length, 0);
		assert.deepEqual(s.pulses.map((p) => [p.kind, p.entryId, p.sectionPath]), [["create", "kb-x", ["top", "memory"]]]); // the section chain rides on the pulse
		// the pulse outlives the flight: nerve run, 10 s lit, then the final ring
		assert.equal(stepKbLife(s, T0 + 9000 + KB_PULSE_MS).pulses.length, 1);
		assert.equal(stepKbLife(s, T0 + 9000 + KB_NERVE_MS + KB_NERVE_GLOW_MS + KB_PULSE_MS - 1).pulses.length, 1);
		assert.equal(stepKbLife(s, T0 + 9000 + KB_NERVE_MS + KB_NERVE_GLOW_MS + KB_PULSE_MS).pulses.length, 0);
	});

	it("a landed pulse runs the nerve for 1.8 s, stays lit for 10 s, then rings; under reduced motion it skips the run", () => {
		const p = { id: "x", kind: "create" as const, at: 1000 };
		assert.deepEqual(kbNerveState(p, 1000 + 900, false), { phase: "run", t: 0.5 });
		assert.deepEqual(kbNerveState(p, 1000 + KB_NERVE_MS + 2500, false), { phase: "lit", t: 0.25 });
		assert.equal(kbNerveState(p, 1000 + KB_NERVE_MS + KB_NERVE_GLOW_MS + 1300, false).phase, "ring");
		assert.equal(kbNerveState(p, 1000 + KB_NERVE_MS + KB_NERVE_GLOW_MS + KB_PULSE_MS, false).phase, "done");
		assert.deepEqual(kbNerveState(p, 1000 + 2500, true), { phase: "lit", t: 0.25 });
		assert.equal(kbNerveState(p, 1000 + KB_NERVE_GLOW_MS, true).phase, "ring");
	});

	it("a result that arrives while the topic is still flying is held until it reaches the curator", () => {
		let s = stepKbLife(feed([promote("t1")]), T0);
		s = reduceKbLife(s, done("t1", "merge", { target: { kind: "kb-entry", id: "kb-y", domain: "wolfpack" } }), T0 + 1000);
		s = stepKbLife(s, T0 + 2000);
		assert.equal(s.flights[0]!.stage, "travel");
		s = stepKbLife(s, T0 + 5000);
		assert.equal(s.flights[0]!.stage, "place");
	});

	it("reject and parked fade at the curator with no pulse; ", () => {
		let s = stepKbLife(feed([promote("t1")]), T0);
		s = stepKbLife(s, T0 + 5000);
		s = reduceKbLife(s, done("t1", "reject", { detail: { outcome: "reject", ref: "t1" } }), T0 + 5000);
		s = stepKbLife(s, T0 + 5000);
		assert.equal(s.flights[0]!.stage, "fade");
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

describe("kb life caps and idle", () => {
	it("the promote queue never holds more than KB_MAX_QUEUE, oldest dropped first", () => {
		const evs = Array.from({ length: KB_MAX_QUEUE + 5 }, (_, i) => promote("q" + i));
		const s = feed(evs);
		assert.deepEqual([s.flights.length, s.flights[0]!.id], [KB_MAX_QUEUE, "q5"]);
	});

	it("a wolf keeps at most KB_MAX_TOPICS_PER_WOLF gathered topics, the oldest forgotten", () => {
		const ids = Array.from({ length: KB_MAX_TOPICS_PER_WOLF + 3 }, (_, i) => "g" + i);
		const s = feed([consolidate(...ids)]);
		assert.deepEqual([s.topics.length, s.topics[0]!.id], [KB_MAX_TOPICS_PER_WOLF, "g3"]);
	});

	it("remembers at most KB_MAX_DOMAINS domains", () => {
		const s = feed(Array.from({ length: KB_MAX_DOMAINS + 4 }, (_, i) => promote("d" + i, "dom" + i)));
		assert.deepEqual([s.domains.length, s.domains.includes("dom0"), s.domains.includes("dom" + (KB_MAX_DOMAINS + 3))], [KB_MAX_DOMAINS, false, true]);
	});

	it("goes idle once every flight, pulse, shimmer and ring ease has settled", () => {
		let s = feed([observe(10_000), promote("t1")]);
		assert.equal(kbLifeBusy(s, T0), true);
		s = stepKbLife(s, T0);
		s = stepKbLife(s, T0 + 5000);
		s = reduceKbLife(s, done("t1", "merge", { target: { kind: "kb-entry", id: "kb-y" } }), T0 + 5000);
		for (const t of [5000, 8000, 11_000, 20_000, 60_000]) s = stepKbLife(s, T0 + t);
		assert.equal(kbLifeBusy(s, T0 + 60_000), false);
	});
});

describe("kb life log", () => {
	const at = (e: ActivityEvent, ms: number) => ({ event: e, at: T0 + ms });
	it("folds repeats of the same step on the same target within a minute into one row with a count", () => {
		const target = { kind: "kb-entry" as const, id: "kb-x", domain: "wolfpack", title: "Zod standard" };
		const rows = foldEvents([at(done("t1", "merge", { target }), 0), at(done("t2", "merge", { target }), 20_000), at(done("t3", "merge", { target }), 200_000), at(observe(1), 0), at(observe(2), 3000)]);
		assert.deepEqual(rows.map((r) => [r.verb, r.n]).sort(), [["merged", 1], ["merged", 2], ["observe", 2]]);
	});

	it("one row per item: promote, start and done of a topic join, the state moves on, and the title is the entry title", () => {
		const target = { kind: "kb-entry" as const, id: "kb-x", domain: "snapjack", title: "Zod standard" };
		const sent = foldEvents([at(observe(1), 0), at(promote("t1", "snapjack"), 100)]);
		assert.deepEqual(sent.map((r) => [r.verb, r.domain, r.title]).sort(), [["observe", null, "1uk4 observed"], ["promote", "snapjack", "1uk4 → snapjack"]].sort());
		const rows = foldEvents([at(promote("t1", "snapjack"), 100), at(start("t1"), 200), at(done("t1", "create", { target }), 3000)]);
		assert.deepEqual(rows.map((r) => [r.verb, r.domain, r.title, r.n, r.entryId]), [["created", "snapjack", "Zod standard", 1, "kb-x"]]);
		assert.ok(["t1", "c-t1"].every((id) => rows[0]!.ids.includes(id))); // ids stay in the details
	});

	it("a merged row without an event title takes the ledger entry title, else shows the entry id; the section title is never the title", () => {
		const target = { kind: "kb-entry" as const, id: "kb-x", domain: "snapjack" };
		const [r] = foldEvents([at(done("t1", "merge", { target }), 0)]);
		assert.deepEqual([r!.title, r!.sectionTitle], ["kb-x", "Memory"]);
		assert.equal(withTitles([r!], new Map([["kb-x", "Zod standard"]]))[0]!.title, "Zod standard");
	});

	it("a rejected item keeps the sender label (no raw topic id), and the reason joins in from the ledger by topic id", () => {
		const rows = foldEvents([at(promote("t1", "snapjack"), 100), at(start("t1"), 200), at(done("t1", "reject"), 900)]);
		assert.deepEqual(rows.map((r) => [r.verb, r.title]), [["rejected", "1uk4 → snapjack"]]);
		assert.equal(withReasons(rows, { t1: "duplicate" })[0]!.reason, "duplicate");
		assert.equal(withReasons(rows, {})[0]!.reason, undefined);
	});

	it("puts a topic under the domain its promote named, wolves' own steps in a null group", () => {
		const groups = groupRows(foldEvents([at(observe(1), 0), at(promote("t1", "snapjack"), 100), at(start("t1"), 200)]));
		assert.deepEqual(groups.map((g) => [g.domain, g.rows.map((r) => r.verb)]).sort(), [["snapjack", ["processing"]], [null, ["observe"]]].sort());
	});

	it("carries ids, outcome, tokens and ms on the row for the details", () => {
		const [r] = foldEvents([at(done("t1", "reject", { detail: { outcome: "reject", ref: "t1", ms: 5, tokens: 77 } }), 0)]);
		assert.deepEqual([r!.verb, r!.tokens, r!.ms, r!.ids.includes("t1")], ["rejected", 77, 5, true]);
	});

	it("drops a history row the live feed already shows and keeps older ones, newest first", () => {
		const live = foldEvents([at(done("t1", "merge", { target: { kind: "kb-entry", id: "k", domain: "wolfpack", title: "A" } }), 0)]);
		const seed = (title: string, ms: number) => ({ ...live[0]!, topic: undefined, entryId: undefined, key: title + ms, title, at: T0 + ms, firstAt: T0 + ms, fold: `merged|${title}`, seed: true as const });
		const rows = mergeSeed(live, [seed("A", -5000), seed("B", -999_999)]);
		assert.deepEqual(rows.map((r) => r.title), ["A", "B"]);
		assert.equal(addRow([], live[0]!).length, 1);
	});
});
