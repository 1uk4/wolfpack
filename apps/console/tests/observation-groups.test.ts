import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEN_GROUP, groupKeyOf, groupLabel, groupObservations, mergeObservations, observationsInGroup } from "../src/core/index.ts";

const o = (id: string, at: string, tags: { work?: string; feature?: string } = {}) => ({ id, timestamp: at, recordedAt: at, content: id, tokenCount: 1, ...tags });

describe("observation grouping", () => {
	it("the work tag decides, then the feature tag, else the den", () => {
		assert.equal(groupKeyOf({ work: "t", feature: "f" }), "t");
		assert.equal(groupKeyOf({ feature: "f" }), "f");
		assert.equal(groupKeyOf({}), DEN_GROUP);
	});
	it("den first, then work items by newest observation, with counts", () => {
		const g = groupObservations([o("a", "1", { work: "t1" }), o("b", "5", { work: "t2" }), o("c", "3"), o("d", "2", { work: "t1" })]);
		assert.deepEqual(g.map((x) => [x.key, x.count]), [["den", 1], ["t2", 1], ["t1", 2]]);
		assert.deepEqual(groupObservations([]), []);
	});
	it("a group's observations come newest first", () => {
		assert.deepEqual(observationsInGroup([o("a", "1", { work: "t" }), o("b", "3", { work: "t" }), o("c", "2")], "t").map((x) => x.id), ["b", "a"]);
	});
	it("merging repeats nothing", () => {
		assert.deepEqual(mergeObservations([o("a", "1"), o("b", "2")], [o("b", "2"), o("c", "3")]).map((x) => x.id), ["c", "b", "a"]);
	});
	it("labels fall back to the id", () => {
		assert.equal(groupLabel(DEN_GROUP, {}), "Den");
		assert.equal(groupLabel("w1", { w1: { title: "T" } }), "T");
		assert.equal(groupLabel("w1", {}), "w1");
	});
});
