import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTopicSize, sourceLabels, topicChip, topicSecondLine, topicsHeader, topicFacts, type MemoryTopicRow } from "../../../src/core/kb/topics-model.ts";

const row = (o: Partial<MemoryTopicRow>): MemoryTopicRow => ({ id: "a", title: "A", bytes: 100, updated: "2026-11-13 10:00", sources: [], state: "active", keepLocal: false, entryIds: [], ...o });

describe("Topics section model", () => {
	it("the chip is the state word with the reason as tooltip; none for an active topic; amber for held and parked", () => {
		assert.equal(topicChip(row({})), null);
		assert.deepEqual(topicChip(row({ state: "promoted" })), { label: "promoted", tone: "good", title: undefined });
		assert.deepEqual(topicChip(row({ state: "held", reason: "distill: log-like" })), { label: "held", tone: "warn", title: "distill: log-like" });
		assert.deepEqual(topicChip(row({ state: "parked", reason: "kb needs attention" })), { label: "parked", tone: "warn", title: "kb needs attention" });
		assert.equal(topicChip(row({ state: "promoted", keepLocal: true }))?.label, "promoted");
	});

	it("the second line exists only for a non-active state or real sources (legacy hidden)", () => {
		assert.equal(topicSecondLine(row({})), null);
		assert.equal(topicSecondLine(row({ sources: ["legacy"] })), null);
		assert.deepEqual(topicSecondLine(row({ sources: ["thread:abc"] })), { chip: null, sources: ["abc"] });
		assert.equal(topicSecondLine(row({ state: "held", reason: "r" }))?.chip?.label, "held");
	});

	it("the topic page frontmatter lists state, reason, sources, updated, size, keep-local and the KB entries as links", () => {
		const facts = topicFacts(row({ state: "held", reason: "distill: log-like", sources: ["thread:abc"], bytes: 2048, keepLocal: true, entryIds: ["e1", "e2"] }));
		assert.deepEqual(facts, [
			{ key: "state", value: "held" },
			{ key: "reason", value: "distill: log-like" },
			{ key: "sources", value: "abc" },
			{ key: "updated", value: "2026-11-13 10:00" },
			{ key: "size", value: "2.0 KB" },
			{ key: "keep local", value: "yes" },
			{ key: "KB entries", value: "e1, e2", entryIds: ["e1", "e2"] },
		]);
		assert.deepEqual(topicFacts(row({})).map((f) => f.key), ["state", "updated", "size", "keep local"]);
	});

	it("the header reads N topics · X KB of Y KB", () => {
		assert.equal(topicsHeader({ topics: [row({}), row({})], totalBytes: 7680, capBytes: 40960, retired: [] }), "2 topics · 7.5 KB of 40.0 KB");
		assert.equal(topicsHeader({ topics: [row({})], totalBytes: 0, capBytes: 20480, retired: [] }), "1 topic · 0.0 KB of 20.0 KB");
	});

	it("sizes read in B or KB, and sources drop the thread: prefix and show legacy as such", () => {
		assert.equal(formatTopicSize(900), "900 B");
		assert.equal(formatTopicSize(7680), "7.5 KB");
		assert.deepEqual(sourceLabels(["thread:abc", "work-wolfpack-oxYNd46"]), ["abc", "work-wolfpack-oxYNd46"]);
		assert.deepEqual(sourceLabels([]), []);
		assert.deepEqual(sourceLabels(["legacy"]), []);
	});
});
