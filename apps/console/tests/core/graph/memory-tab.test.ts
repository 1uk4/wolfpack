import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { curatorCounts, curatorText, formatPool, memoryRows, pendingNotice, poolBars, resolveTab, tabItems, tabsFor, type FeedLine } from "../../../src/core/index.ts";

let n = 0;
const ev = (verb: string, o: Partial<ActivityEvent> = {}): ActivityEvent => ({ v: 1, id: `m${++n}`, pack: "p", ts: 0, ttlMs: 1000, actor: { kind: "wolf", wolf: "jack" }, verb, ...o }) as ActivityEvent;
const hub = { kind: "hub", title: "curator" } as ActivityEvent["actor"];
const at = (event: ActivityEvent, t: number) => ({ event, at: t });

describe("memory rows", () => {
	it("words each step: saved notes, topics to the curator (folded per wolf), filed, merged, rejected; observes are not rows", () => {
		const rows = memoryRows([
			at(ev("memory-observe", { detail: { count: 100, capacity: 400 } }), 1000),
			at(ev("memory-consolidate", { detail: { count: 5, topicIds: ["t1", "t2", "t3"] } }), 2000),
			at(ev("memory-promote", { detail: { ref: "r1", topicIds: ["t1"] } }), 3000),
			at(ev("memory-promote", { detail: { ref: "r2", topicIds: ["t2"] } }), 4000),
			at(ev("memory-promote", { detail: { ref: "r3", topicIds: ["t3"] } }), 5000),
			at(ev("curate-done", { actor: hub, target: { kind: "kb-entry", id: "kb-wolfpack-A", domain: "wolfpack", title: "Console" }, detail: { outcome: "create", topicIds: ["t1"], sectionTitle: "Console" } }), 9000),
			at(ev("curate-done", { actor: hub, target: { kind: "kb-entry", id: "kb-wolfpack-B", domain: "wolfpack", title: "Graph" }, detail: { outcome: "merge", topicIds: ["t2"] } }), 10_000),
			at(ev("curate-done", { actor: hub, detail: { outcome: "reject", topicIds: ["t3"] } }), 11_000),
		]);
		assert.deepEqual(rows.map((r) => r.text), ["Rejected", "Merged into Graph", "Filed into Wolfpack › Console", "3 topics to the curator", "jack saved 5 notes"]);
		assert.deepEqual(rows.map((r) => r.at), [11_000, 10_000, 9000, 5000, 2000]);
	});

	it("each row names the wolf and topic dot to highlight (a curator result finds the wolf through the topic) and keeps the entry as a target", () => {
		const rows = memoryRows([
			at(ev("memory-promote", { detail: { ref: "r1", topicIds: ["t1"] } }), 3000),
			at(ev("curate-done", { actor: hub, target: { kind: "kb-entry", id: "kb-wolfpack-A", domain: "wolfpack", title: "Console" }, detail: { outcome: "create", topicIds: ["t1"] } }), 9000),
		]);
		assert.deepEqual(rows[0]!.focus, { wolf: "jack", target: { kind: "kb-entry", id: "kb-wolfpack-A", domain: "wolfpack" }, topicId: "t1" });
		assert.deepEqual(rows[1]!.focus, { wolf: "jack", topicId: "t1" });
	});

	it("says one note and one topic in the singular", () => {
		const rows = memoryRows([at(ev("memory-consolidate", { detail: { count: 1 } }), 1), at(ev("memory-promote", { detail: { topicIds: ["x"] } }), 70_000)]);
		assert.deepEqual(rows.map((r) => r.text), ["1 topic to the curator", "jack saved 1 note"]);
	});
});

describe("pool bars", () => {
	it("keeps the latest observe per wolf as tokens against the threshold", () => {
		const bars = poolBars([
			at(ev("memory-observe", { detail: { count: 6000, capacity: 40000 } }), 1),
			at(ev("memory-observe", { actor: { kind: "wolf", wolf: "hal" }, detail: { count: 100, capacity: 20000 } }), 2),
			at(ev("memory-observe", { detail: { count: 8600, capacity: 40000 } }), 3),
			at(ev("memory-consolidate", { detail: { count: 3 } }), 4),
		]);
		assert.deepEqual(bars, { jack: { count: 8600, capacity: 40000 }, hal: { count: 100, capacity: 20000 } });
	});

	it("formats '8.6k of 40k' and clamps nothing for a wolf not seen yet", () => {
		assert.equal(formatPool({ count: 8600, capacity: 40000 }), "8.6k of 40k");
		assert.equal(formatPool({ count: 950, capacity: 40000 }), "950 of 40k");
		assert.equal(formatPool(undefined), "–");
	});
});

describe("stuck saves notice", () => {
	it("reads 'Saves stuck for 2h · retry in 40m' with the message as its hover text, and is null with nothing stuck", () => {
		assert.deepEqual(pendingNotice({ stuck: 2, oldestAgeMs: 7_200_000, nextRetryInMs: 2_400_000, message: "boom" }), { text: "Saves stuck for 2h · retry in 40m", title: "boom" });
		assert.deepEqual(pendingNotice({ stuck: 1, oldestAgeMs: 90_000, nextRetryInMs: 0 }), { text: "Saves stuck for 1m · retry due", title: "" });
		assert.equal(pendingNotice(undefined), null);
	});

	it("names the real error once a save has failed 3 times, instead of only \"retry due\"", () => {
		assert.deepEqual(pendingNotice({ stuck: 1, oldestAgeMs: 172_800_000, nextRetryInMs: 0, tries: 3, message: "Work API PATCH k: HTTP 502" }), { text: "Saves stuck for 2d · Work API PATCH k: HTTP 502", title: "Work API PATCH k: HTTP 502" });
		assert.equal(pendingNotice({ stuck: 1, oldestAgeMs: 90_000, nextRetryInMs: 0, tries: 2, message: "boom" })?.text, "Saves stuck for 1m · retry due");
	});
});

describe("tabs", () => {
	const line = (key: string, time: number): FeedLine => ({ key, wolf: "jack", color: "red", text: key, time, tone: "normal" });
	const row = (key: string, time: number) => ({ key, at: time, text: key, focus: {} });

	it("hides the Memory tab when the graph's Memory switch is off, and falls back to All", () => {
		assert.deepEqual(tabsFor(true), ["all", "kb", "memory"]);
		assert.deepEqual(tabsFor(false), ["all", "kb"]);
		assert.equal(resolveTab("memory", false), "all");
		assert.equal(resolveTab("memory", true), "memory");
		assert.equal(resolveTab("bogus", true), "all");
		assert.equal(resolveTab(null, true), "all");
	});

	it("All merges feed lines and memory rows by time, KB shows only KB-target lines (no thread or work lines), Memory rows only, and Memory off drops the rows everywhere", () => {
		const kbLine = (key: string, time: number): FeedLine => ({ ...line(key, time), target: { kind: "kb-entry", id: "kb-wolfpack-A" } });
		const lines = [kbLine("l1", 1000), kbLine("l2", 3000), line("thread", 3500)];
		const rows = [row("r1", 2000)];
		const keys = (t: Parameters<typeof tabItems>[0], on: boolean) => tabItems(t, lines, rows, on).map((i) => i.key);
		assert.deepEqual(keys("all", true), ["l1", "r1", "l2", "thread"]);
		assert.deepEqual(keys("kb", true), ["l1", "l2"]);
		assert.deepEqual(keys("kb", false), ["l1", "l2"]);
		assert.deepEqual(keys("memory", true), ["r1"]);
		assert.deepEqual(keys("all", false), ["l1", "l2", "thread"]);
		assert.deepEqual(keys("memory", false), ["l1", "l2", "thread"]);
	});
});

describe("curator line", () => {
	const start = (id: string) => at(ev("curate-start", { actor: hub, detail: { topicIds: [id] } }), 1);
	const done = (id: string) => at(ev("curate-done", { actor: hub, detail: { outcome: "merge", topicIds: [id] } }), 2);
	it("counts filing as curate-start without its curate-done, and words pending and filing", () => {
		assert.deepEqual(curatorCounts(3, [start("a"), start("b"), done("a")]), { pending: 3, filing: 1 });
		assert.deepEqual(curatorCounts(0, [start("a"), done("a")]), { pending: 0, filing: 0 });
		assert.equal(curatorText({ pending: 3, filing: 1 }), "Curator · 3 pending · 1 filing");
		assert.equal(curatorText({ pending: 3, filing: 0 }), "Curator · 3 pending");
		assert.equal(curatorText({ pending: 0, filing: 2 }), "Curator · 2 filing");
		assert.equal(curatorText({ pending: 0, filing: 0 }), null);
	});
});
