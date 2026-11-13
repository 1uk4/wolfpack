import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTopicSize, sourceLabels, topicChip, type MemoryTopicRow } from "../../../src/core/kb/topics-model.ts";

const row = (o: Partial<MemoryTopicRow>): MemoryTopicRow => ({ id: "a", title: "A", bytes: 100, updated: "2026-11-13 10:00", sources: [], state: "active", keepLocal: false, entryIds: [], ...o });

describe("Topics section model", () => {
	it("the chip shows keep-local over the state, held with its reason, parked as needing attention", () => {
		assert.equal(topicChip(row({})).label, "active");
		assert.equal(topicChip(row({ state: "promoted" })).label, "promoted");
		assert.equal(topicChip(row({ state: "retired" })).label, "retired");
		assert.equal(topicChip(row({ state: "held", reason: "distill: log-like" })).label, "held: distill: log-like");
		assert.deepEqual(topicChip(row({ state: "parked" })), { label: "parked (needs attention)", tone: "warn" });
		assert.equal(topicChip(row({ state: "promoted", keepLocal: true })).label, "keep-local");
	});

	it("sizes read in B or KB, and sources drop the thread: prefix and show legacy as such", () => {
		assert.equal(formatTopicSize(900), "900 B");
		assert.equal(formatTopicSize(7680), "7.5 KB");
		assert.deepEqual(sourceLabels(["thread:abc", "work-wolfpack-oxYNd46"]), ["abc", "work-wolfpack-oxYNd46"]);
		assert.deepEqual(sourceLabels([]), ["legacy"]);
	});
});
