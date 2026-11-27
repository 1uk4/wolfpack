import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLabelTree, chooseLabels, effectiveZoom, labelTop, parentChain, type LabelCandidate } from "../../../src/core/graph/label-lod.ts";

const cand = (id: string, level: 0 | 1 | 2 | 3, sx: number, sy: number, size = 0): LabelCandidate => ({ id, level, size, sx, sy, below: 0, widthEm: 6 });
const view = { width: 1000, height: 800 };

describe("label levels from depth and size", () => {
	const kids = Array.from({ length: 12 }, (_, i) => `k${i}`);
	const all = ["dom", "bigSec", "sec", "leaf", "leaf2", ...kids];
	const edges = [
		{ from: "dom", to: "bigSec" },
		{ from: "dom", to: "sec" },
		{ from: "sec", to: "leaf" },
		{ from: "dom", to: "leaf2" },
		...kids.map((k) => ({ from: "bigSec", to: k })),
	];
	const depths = new Map<string, number>([["dom", 0], ["bigSec", 1], ["sec", 1], ["leaf", 2], ["leaf2", 1], ...kids.map((k) => [k, 2] as [string, number])]);
	const tree = buildLabelTree(all, edges, depths);

	it("ranks domains and big sections above small sections above leaves", () => {
		assert.equal(tree.get("dom")!.level, 1);
		assert.equal(tree.get("bigSec")!.level, 1); // depth 1 but 12 children: promoted
		assert.equal(tree.get("sec")!.level, 2);
		assert.equal(tree.get("leaf")!.level, 3);
		assert.equal(tree.get("leaf2")!.level, 3); // a childless depth-1 node is still a leaf
	});

	it("builds the parent chain for hover", () => {
		assert.deepEqual(parentChain("leaf", tree), ["leaf", "sec", "dom"]);
	});
});

describe("zoom reveals one level at a time", () => {
	const cs = [cand("g", 0, 100, 100), cand("d", 1, 300, 100), cand("s", 2, 500, 100), cand("l", 3, 700, 100)];
	const at = (z: number) => [...chooseLabels(cs, { ...view, ze: effectiveZoom(z, 0.5) })].sort();

	it("zoomed out shows only groups and domains, zoomed in adds sections then leaves, groups hand over", () => {
		assert.deepEqual(at(1), ["d", "g"]);
		assert.deepEqual(at(1.5), ["d", "s"]);
		assert.deepEqual(at(3), ["d", "l", "s"]);
	});

	it("a higher Labels-until-zoom setting reveals labels sooner", () => {
		assert.deepEqual([...chooseLabels(cs, { ...view, ze: effectiveZoom(1, 1.5) })].sort(), ["d", "l", "s"]);
	});
});

describe("collisions", () => {
	it("the higher level wins an overlap and the lower hides", () => {
		const cs = [cand("leaf", 3, 500, 400), cand("dom", 1, 505, 402), cand("far", 3, 100, 100)];
		assert.deepEqual([...chooseLabels(cs, { ...view, ze: 5 })].sort(), ["dom", "far"]);
	});

	it("at the same level the bigger parent wins", () => {
		const cs = [cand("small", 2, 500, 400, 3), cand("large", 2, 502, 400, 20)];
		assert.deepEqual([...chooseLabels(cs, { ...view, ze: 5 })], ["large"]);
	});

	it("forced (hovered) labels show even when hidden by zoom or overlap", () => {
		const cs = [cand("dom", 1, 500, 400), cand("leaf", 3, 500, 400)];
		const got = chooseLabels(cs, { ...view, ze: 1, forced: new Set(["leaf", "dom"]) });
		assert.deepEqual([...got].sort(), ["dom", "leaf"]);
	});
});

describe("label anchor", () => {
	it("centres a title on its anchor and hangs a node label below its disc, one formula for the collision rect and the draw", () => {
		assert.equal(labelTop(100, 0, 20), 87.5);
		assert.equal(labelTop(100, 6, 20), 106);
	});
});

describe("wolf badges are obstacles (work-wolfpack-1Djd6IR)", () => {
	it("a label overlapping a badge hides unless it is hovered or selected", () => {
		const cs = [cand("under", 3, 500, 400), cand("clear", 3, 100, 100)];
		const obstacles = [{ sx: 505, sy: 400, r: 14 }];
		assert.deepEqual([...chooseLabels(cs, { ...view, ze: 5, obstacles })], ["clear"]);
		assert.deepEqual([...chooseLabels(cs, { ...view, ze: 5, obstacles, forced: new Set(["under"]) })].sort(), ["clear", "under"]);
	});
});

describe("domains outrank sections (work-wolfpack-Wu0RH2z)", () => {
	it("a domain label beats a bigger level-1 section in a collision", () => {
		const cs: LabelCandidate[] = [cand("sec", 1, 500, 400, 40), { ...cand("dom", 1, 505, 402, 3), domain: true }];
		assert.deepEqual([...chooseLabels(cs, { ...view, ze: 1 })], ["dom"]);
	});

	it("marks domains, and a bucket node (Inbox, Factory) is not promoted by child count", () => {
		const a = Array.from({ length: 14 }, (_, i) => `a${i}`);
		const b = Array.from({ length: 14 }, (_, i) => `b${i}`);
		const ids = ["dom", "inbox", "big", ...a, ...b];
		const edges = [{ from: "dom", to: "inbox" }, { from: "dom", to: "big" }, ...a.map((k) => ({ from: "inbox", to: k })), ...b.map((k) => ({ from: "big", to: k }))];
		const depths = new Map<string, number>([["dom", 0], ["inbox", 1], ["big", 1], ...[...a, ...b].map((k) => [k, 2] as [string, number])]);
		const t = buildLabelTree(ids, edges, depths, (id) => id === "inbox");
		assert.equal(t.get("big")!.level, 1);
		assert.equal(t.get("inbox")!.level, 2);
		assert.equal(t.get("dom")!.domain, true);
		assert.equal(t.get("big")!.domain, false);
	});
});
