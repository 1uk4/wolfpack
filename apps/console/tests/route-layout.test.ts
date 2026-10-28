/**
 * Route straightening: the pure target layout, the hierarchy-link filter the
 * simulation runs on while a route is selected, and the draw list at the new
 * positions. Pure — no DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDepDrawList, edgeKey } from "../src/core/dep-draw-list.ts";
import { createGraphSimulation } from "../src/core/layout.ts";
import { ROUTE_LATERAL_SPACING, routeFilteredEdges, routeTargetLayout } from "../src/core/route-layout.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);
const A = { root: { x: 0, y: 0 }, target: { x: 400, y: 0 } };

describe("routeTargetLayout", () => {
	it("a chain is evenly spaced along the line, anchors unchanged", () => {
		const out = routeTargetLayout("fac", "t", A, [["a"], ["b"], ["c"], ["t"]]);
		assert.deepEqual(out.get("fac"), { x: 0, y: 0 });
		assert.deepEqual(out.get("t"), { x: 400, y: 0 });
		near(out.get("a")!.x, 100);
		near(out.get("b")!.x, 200);
		near(out.get("c")!.x, 300);
		for (const id of ["a", "b", "c"]) near(out.get(id)!.y, 0);
	});
	it("a diamond spreads perpendicular to the line, symmetric about it", () => {
		const out = routeTargetLayout("fac", "t", A, [["a"], ["b1", "b2", "b3"], ["t"]]);
		const bs = ["b1", "b2", "b3"].map((id) => out.get(id)!);
		for (const p of bs) near(p.x, 400 * (2 / 3));
		near(bs[1]!.y, 0);
		near(bs[0]!.y, -ROUTE_LATERAL_SPACING);
		near(bs[2]!.y, ROUTE_LATERAL_SPACING);
		const two = routeTargetLayout("fac", "t", A, [["p", "q"], ["t"]]);
		near(two.get("p")!.y + two.get("q")!.y, 0);
		near(two.get("q")!.y - two.get("p")!.y, ROUTE_LATERAL_SPACING);
	});
	it("perpendicular follows a diagonal line", () => {
		const out = routeTargetLayout("fac", "t", { root: { x: 0, y: 0 }, target: { x: 100, y: 100 } }, [["p", "q"], ["t"]]);
		const p = out.get("p")!;
		const q = out.get("q")!;
		near((q.x - p.x) * 1 + (q.y - p.y) * 1, 0); // chord ⟂ (1,1)
		near((p.x + q.x) / 2, 50);
		near((p.y + q.y) / 2, 50);
	});
	it("a single-step route is just the target (no movers)", () => {
		const out = routeTargetLayout("fac", "t", A, [["t"]]);
		assert.deepEqual([...out.keys()].sort(), ["fac", "t"]);
		assert.deepEqual(out.get("t"), A.target);
	});
});

describe("routeFilteredEdges / simulation links", () => {
	const edges = [
		{ from: "init", to: "feat" }, // initiative -> feature (route member)
		{ from: "feat", to: "task" }, // feature -> task (both members)
		{ from: "fac:d", to: "root" }, // Factory -> root work
		{ from: "fac:d", to: "other" }, // Factory -> unrelated: stays
		{ from: "init", to: "sib" }, // untouched
	];
	const members = new Set(["fac:d", "root", "feat", "task"]);
	it("removes hierarchy links of route members, keeps the rest", () => {
		const kept = routeFilteredEdges(edges, members);
		assert.deepEqual(kept.map((e) => `${e.from}>${e.to}`), ["fac:d>other", "init>sib"]);
	});
	it("the simulation really runs on the filtered links, and on all of them once restored", () => {
		const nodes = () => ["init", "feat", "task", "fac:d", "root", "other", "sib"].map((id, i) => ({ id, x: i * 10, y: 0 }));
		const linkCount = (es: typeof edges) => (createGraphSimulation(nodes(), es).force("link") as unknown as { links(): unknown[] }).links().length;
		assert.equal(linkCount(routeFilteredEdges(edges, members)), 2);
		assert.equal(linkCount(edges), 5); // deselect: the spokes return
	});
});

describe("route drawn at the straightened positions", () => {
	it("the draw list reads whatever positions it is given", () => {
		const straight = new Map([["fac:d", { x: 0, y: 0 }], ["a", { x: 100, y: 0 }], ["t", { x: 200, y: 0 }]]);
		const route = { nodes: new Set(["fac:d", "a", "t"]), edges: new Set(["fac:d|a", "a|t"]), parallel: new Set<string>(), done: new Set<string>() };
		const list = buildDepDrawList({
			edges: [{ from: "a", to: "t" }],
			factories: [{ members: ["fac:d", "a", "t"] }],
			positions: straight,
			viewport: { minX: -10, minY: -10, maxX: 300, maxY: 10 },
			ratio: 0.3,
			route,
		});
		assert.deepEqual(list.arrows.map((a) => [edgeKey(a.from, a.to), a.bright]), [["a|t", true], ["fac:d|a", true]]);
		// A viewport empty of the OLD layout but covering the new one still draws it.
		assert.equal(list.arrows.length, 2);
	});
});

describe("routeDragLayout", () => {
	it("a pinned target moves the far anchor; other pins sit where dropped; the Factory never moves", async () => {
		const { routeDragLayout, routeTargetLayout } = await import("../src/core/route-layout.ts");
		const steps = [["a", "b"], ["t"]];
		const anchors = { root: { x: 0, y: 0 }, target: { x: 200, y: 0 } };
		const pins = new Map([["t", { x: 0, y: 100 }], ["a", { x: 7, y: 7 }], ["fac:d", { x: 9, y: 9 }]]);
		const out = routeDragLayout("fac:d", "t", anchors, steps, pins);
		const base = routeTargetLayout("fac:d", "t", { root: anchors.root, target: { x: 0, y: 100 } }, steps);
		assert.deepEqual(out.get("t"), { x: 0, y: 100 });
		assert.deepEqual(out.get("a"), { x: 7, y: 7 });
		assert.deepEqual(out.get("b"), base.get("b"));
		assert.deepEqual(out.get("fac:d"), { x: 0, y: 0 });
	});
});
