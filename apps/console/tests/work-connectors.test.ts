import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARROW_W, GUTTER_PAD, LANE_W, WORK_ROW_H, allocateLanes, groupConnectors, laneState, lanePath, LANE_COLOR } from "../src/core/work-connectors.ts";
import { buildWorkTable, type TableRow } from "../src/core/work-table.ts";
import { workRouteView } from "../src/core/work-select.ts";
import type { WorkListItem } from "../src/core/kb.ts";

const item = (id: string, over: Partial<WorkListItem> = {}): WorkListItem => ({ id, title: id.toUpperCase(), kind: "task", stage: "plan", domain: "d", dependsOn: [], created: "2026-10-01", ...over });
const group = (specs: [string, string[]][], over: Record<string, Partial<WorkListItem>> = {}): TableRow =>
	buildWorkTable(specs.map(([id, dependsOn]) => item(id, { dependsOn, ...over[id] })), { sort: { col: "name", dir: 1 } }).groups[0]!;
const open = () => true;
const lanesOf = (g: TableRow) => groupConnectors(g, open);

describe("allocateLanes", () => {
	it("a chain of back-to-back spans needs a single lane", () => {
		assert.deepEqual(allocateLanes([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]), { lanes: [0, 0, 0], count: 1 });
	});
	it("overlapping spans take separate lanes; a free lane is reused", () => {
		assert.deepEqual(allocateLanes([{ start: 0, end: 5 }, { start: 1, end: 2 }, { start: 3, end: 4 }]), { lanes: [0, 1, 1], count: 2 });
	});
	it("nothing → no lanes", () => assert.deepEqual(allocateLanes([]), { lanes: [], count: 0 }));
});

describe("groupConnectors", () => {
	it("a chain draws one lane, each edge ending at its dependent's row", () => {
		const gc = lanesOf(group([["a", []], ["b", ["a"]], ["c", ["b"]]]));
		assert.equal(gc.lanes, 1);
		assert.deepEqual(gc.edges.map((e) => [e.from, e.to, e.lane, e.fromRow, e.toRow]), [["a", "b", 0, 1, 2], ["b", "c", 0, 2, 3]]);
	});
	it("a diamond: two incoming lanes reach D's row (they join at its arrow); the parallel rows share no connector", () => {
		const gc = lanesOf(group([["a", []], ["b", ["a"]], ["c", ["a"]], ["d", ["b", "c"]]]));
		const into = gc.edges.filter((e) => e.to === "d");
		assert.equal(into.length, 2);
		assert.equal(new Set(into.map((e) => e.toRow)).size, 1);
		assert.equal(new Set(into.map((e) => e.lane)).size, 2, "distinct trunks arrive on distinct lanes");
		assert.ok(!gc.edges.some((e) => (e.from === "b" && e.to === "c") || (e.from === "c" && e.to === "b")));
		assert.equal(gc.lanes, 2);
		// both branches end at the same arrow x, just before the arrowhead
		const heads = into.map((e) => lanePath(e, gc.lanes).d.split("H")[1]);
		assert.equal(new Set(heads).size, 1);
		assert.equal(gc.width, GUTTER_PAD * 2 + 2 * LANE_W + ARROW_W);
	});
	it("a fan-out shares one trunk lane", () => {
		const gc = lanesOf(group([["a", []], ["b", ["a"]], ["c", ["a"]]]));
		assert.equal(gc.lanes, 1);
		assert.deepEqual(gc.edges.map((e) => e.lane), [0, 0]);
	});
	it("independent rows have no edges and no gutter", () => {
		const gc = lanesOf(group([["a", []], ["b", []]]));
		assert.deepEqual([gc.edges, gc.lanes, gc.width], [[], 0, 0]);
	});
	it("a collapsed group hides its lanes", () => {
		const g = group([["a", []], ["b", ["a"]]]);
		const gc = groupConnectors(g, () => false);
		assert.deepEqual([gc.rows.length, gc.edges.length, gc.width], [1, 0, 0]);
	});
	it("a collapsed feature hides its task lanes but keeps feature → feature lanes spanning the open ones", () => {
		const t = buildWorkTable(
			[
				item("i", { kind: "initiative" }),
				item("f1", { kind: "feature", partOf: "i" }),
				item("f2", { kind: "feature", partOf: "i", dependsOn: ["f1"] }),
				item("t1", { partOf: "f1" }),
				item("t2", { partOf: "f1", dependsOn: ["t1"] }),
			],
			{ sort: { col: "name", dir: 1 } },
		);
		const init = t.groups[0]!;
		const closed = groupConnectors(init, (r) => r.id === "i");
		assert.deepEqual(closed.edges.map((e) => [e.from, e.to]), [["f1", "f2"]]);
		const all = groupConnectors(init, () => true);
		assert.deepEqual(all.edges.map((e) => `${e.from}>${e.to}`).sort(), ["f1>f2", "t1>t2"]);
		assert.equal(all.lanes, 2, "the feature lane runs past the task lane");
		assert.equal(all.rows.length, 5);
	});
	it("a done dependent's lane is done; others are not", () => {
		const gc = lanesOf(group([["a", []], ["b", ["a"]], ["c", ["a"]]], { b: { stage: "shipped" } }));
		assert.deepEqual(gc.edges.map((e) => [e.to, e.done]), [["b", true], ["c", false]]);
	});
	it("dependencies outside the parent are notes, never lanes", () => {
		const t = buildWorkTable([item("f1", { kind: "feature" }), item("f2", { kind: "feature" }), item("x", { partOf: "f1" }), item("y", { partOf: "f2", dependsOn: ["x"] })]);
		const f2 = t.groups[0]!.children.find((r) => r.id === "f2")!;
		assert.equal(groupConnectors(t.groups[0]!, open).edges.length, 0);
		assert.deepEqual(f2.children[0]!.notes.map((n) => n.title), ["X"]);
	});
});

describe("laneState / colours", () => {
	const e = { from: "a", to: "b", done: false };
	it("done lanes are the muted grey; lit lanes the route colour; the rest faint", () => {
		assert.equal(LANE_COLOR[laneState({ ...e, done: true }, null)], "#7d8493");
		assert.equal(laneState(e, null), "plain");
		assert.equal(LANE_COLOR.lit, "#ffd166");
	});
	it("the selected row's lanes light up, in either direction; unrelated lanes do not", () => {
		const v = workRouteView(null, "b", null);
		assert.equal(laneState(e, v), "lit");
		assert.equal(laneState({ ...e, from: "b", to: "c" }, v), "lit");
		assert.equal(laneState({ ...e, from: "x", to: "y" }, v), "plain");
	});
	it("lanes between two route steps light; a done lane stays grey even on the route", () => {
		const v = { selected: "z", cursor: null, steps: { x: { step: 1, parallel: false }, y: { step: 2, parallel: false } }, collapsed: {} };
		assert.equal(laneState({ from: "x", to: "y", done: false }, v), "lit");
		assert.equal(laneState({ from: "x", to: "y", done: true }, v), "done");
	});
});

describe("lanePath", () => {
	it("runs from below the prerequisite's row to an elbow at the dependent's centre", () => {
		const p = lanePath({ from: "a", to: "b", lane: 0, fromRow: 1, toRow: 2, done: false }, 1);
		const toY = 2 * WORK_ROW_H + WORK_ROW_H / 2;
		assert.match(p.d, new RegExp(`^M[\\d.]+ [\\d.]+V${toY - 3}Q[\\d.]+ ${toY} [\\d.]+ ${toY}H`));
	});
});
