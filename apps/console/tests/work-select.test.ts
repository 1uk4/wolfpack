/** The Work view's selection model (pure): route view, row state, ancestor keys, the column width clamp. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeWorkRoute } from "../src/core/work-route.ts";
import { ancestorKeys, parseWorkColWidth, rowRouteState, workRouteView } from "../src/core/work-select.ts";
import { buildWorkTable } from "../src/core/work-table.ts";

const nodes = [
	{ id: "f", kind: "feature", stage: "in_build" },
	{ id: "a", kind: "task", stage: "shipped", parent: "f" },
	{ id: "b", kind: "task", stage: "plan", parent: "f", dependsOn: ["a"] },
	{ id: "c", kind: "task", stage: "plan", parent: "f", dependsOn: ["a"] },
	{ id: "x", kind: "task", stage: "plan", parent: "f" },
];

describe("workRouteView / rowRouteState", () => {
	const route = computeWorkRoute(nodes, "b", { collapseDoneFeatures: true });
	const view = workRouteView(route, "b", "b");
	it("numbers rows by 1-based step, parallel steps sharing one", () => {
		const on = (id: string) => rowRouteState(view, id);
		assert.ok(on("a").mode === "on" && on("b").mode === "on");
		assert.ok(rowRouteState(view, "a").mode === "on" && (rowRouteState(view, "a") as { step: number }).step === route.steps.find((s) => s.nodes.includes("a"))!.index + 1);
	});
	it("dims rows off the route, never the id-less group, marks selected and cursor", () => {
		assert.ok(rowRouteState(view, "x").mode === "off");
		assert.ok(rowRouteState(view, "").mode === "none");
		const b = rowRouteState(view, "b");
		assert.ok(b.selected && b.cursor);
		assert.ok(!rowRouteState(view, "a").cursor);
	});
	it("no selection means no state; a selection with no route dims nothing", () => {
		assert.ok(rowRouteState(null, "a").mode === "none");
		const lone = workRouteView(null, "q", null);
		assert.ok(rowRouteState(lone, "q").mode === "on" && rowRouteState(lone, "a").mode === "none");
	});
});

describe("ancestorKeys", () => {
	it("opens the groups above the lit rows", () => {
		const items = [
			{ id: "i", title: "I", kind: "initiative", stage: "plan", domain: "d", dependsOn: [] },
			{ id: "f", title: "F", kind: "feature", stage: "plan", domain: "d", dependsOn: [], partOf: "i" },
			{ id: "t", title: "T", kind: "task", stage: "plan", domain: "d", dependsOn: [], partOf: "f" },
		];
		const table = buildWorkTable(items);
		assert.deepEqual(ancestorKeys(table.groups, new Set(["t"])).sort(), ["f", "i"]);
		assert.deepEqual(ancestorKeys(table.groups, new Set(["f"])), ["i"]);
		assert.deepEqual(ancestorKeys(table.groups, new Set()), []);
	});
});

describe("parseWorkColWidth", () => {
	it("defaults when absent or corrupt, clamps like the pane", () => {
		assert.ok(parseWorkColWidth(null) === 520 && parseWorkColWidth("zz") === 520);
		assert.ok(parseWorkColWidth("50") === 280 && parseWorkColWidth("5000") === 720);
		assert.ok(parseWorkColWidth("600", 800) === 560);
	});
});
