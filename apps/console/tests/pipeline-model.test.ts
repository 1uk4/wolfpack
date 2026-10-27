import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KbPipelineResponse } from "../src/core/pipeline-model.ts";
import { applySweepEvent, formatAge, initialState, lanes, normalizeOutcome, relativeTime, sweepSummary } from "../src/core/pipeline-model.ts";

const base = (): KbPipelineResponse => ({
	lanes: [
		{ wolf: "b", pending: 0 },
		{ wolf: "a", pending: 1, oldestAgeMs: 1000 },
		{ wolf: "c", pending: 2, oldestAgeMs: 90_000 },
	],
	receipts: [],
	parked: [],
	sweep: {},
});
const ev = (o: Record<string, unknown>) => ({ wolf: "lib", timestamp: "2026-10-26T10:00:00.000Z", domain: "kb", target: { kind: "den" }, ...o }) as never;

describe("normalizeOutcome", () => {
	it("accepts both spellings", () => {
		for (const [i, o] of [["create", "create"], ["created", "create"], ["merge", "merge"], ["merged", "merge"], ["updated", "merge"], ["reject", "reject"], ["rejected", "reject"], ["parked", "parked"], ["weird", "unclassified"], [undefined, "unclassified"]] as const) {
			assert.equal(normalizeOutcome(i), o);
		}
	});
});

describe("lanes", () => {
	it("busy lanes first, oldest first, then idle by name", () => {
		assert.deepEqual(lanes(base()).map((l) => l.wolf), ["c", "a", "b"]);
	});
});

describe("sweepSummary", () => {
	it("never / finished / running", () => {
		assert.equal(sweepSummary(initialState(base())).kind, "never");
		const last = { startedAt: "x", finishedAt: "y", processed: 1, created: 1, merged: 0, rejected: 0, parked: 0, remaining: 0, durationMs: 5 };
		const fin = sweepSummary(initialState({ ...base(), sweep: { last: { ...last, error: "boom" } } }));
		assert.equal(fin.kind === "finished" && fin.ok, false);
		const run = sweepSummary(initialState({ ...base(), sweep: { current: { from: "a", denTopicId: "t", startedAt: "z" } } }));
		assert.equal(run.kind, "running");
	});
});

describe("applySweepEvent", () => {
	it("folds started → item → finished", () => {
		let s = initialState(base());
		s = applySweepEvent(s, ev({ type: "sweep_started", pending: 3 }));
		assert.deepEqual(sweepSummary(s), { kind: "running", pending: 3 });
		s = applySweepEvent(s, ev({ type: "sweep_item", from: "a", denTopicId: "t1", outcome: "create", entryId: "e1" }));
		assert.equal(s.data.receipts[0]?.entryId, "e1");
		assert.equal(s.data.lanes.find((l) => l.wolf === "a")?.pending, 0);
		assert.equal(s.data.lanes.find((l) => l.wolf === "a")?.oldestAgeMs, undefined);
		s = applySweepEvent(s, ev({ type: "sweep_item", from: "c", denTopicId: "t2", outcome: "parked" }));
		assert.equal(s.data.parkedTotal, 1);
		s = applySweepEvent(s, ev({ type: "sweep_finished", processed: 2, created: 1, merged: 0, rejected: 0, parked: 1, remaining: 1, durationMs: 40, error: "x" }));
		const sum = sweepSummary(s);
		assert.equal(sum.kind, "finished");
		assert.equal(s.running, null);
	});
	it("ignores other events by reference", () => {
		const s = initialState(base());
		assert.equal(applySweepEvent(s, ev({ type: "record_written" })), s);
	});
	it("caps receipts at 50", () => {
		let s = initialState(base());
		for (let i = 0; i < 60; i++) s = applySweepEvent(s, ev({ type: "sweep_item", from: "a", denTopicId: `t${i}`, outcome: "merge" }));
		assert.equal(s.data.receipts.length, 50);
	});
});

describe("time", () => {
	it("formats", () => {
		assert.equal(formatAge(5 * 60_000), "5m");
		assert.equal(relativeTime("2026-10-26T10:00:00Z", Date.parse("2026-10-26T10:03:00Z")), "3m ago");
		assert.equal(relativeTime("2026-10-26T10:00:00Z", Date.parse("2026-10-26T10:00:01Z")), "just now");
	});
});
