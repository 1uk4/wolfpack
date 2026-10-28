/**
 * Route physics: the pure target layout, the link set the simulation runs on
 * while a route is selected, the weak line force, and the draw list at the
 * positions it is given. Pure — no DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDepDrawList, edgeKey } from "../src/core/dep-draw-list.ts";
import { createGraphSimulation } from "../src/core/layout.ts";
import { ROUTE_LATERAL_SPACING, routeFilteredEdges, routeLineForce, routeLinkSet, routeTargetLayout } from "../src/core/route-layout.ts";

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

describe("routeLinkSet", () => {
	const edges = [
		{ from: "init", to: "feat" },
		{ from: "feat", to: "task" },
		{ from: "fac:d", to: "root" },
		{ from: "fac:d", to: "other" },
		{ from: "init", to: "sib" },
	];
	const members = new Set(["fac:d", "root", "feat", "task"]);
	const all = new Set(["init", "feat", "task", "fac:d", "root", "other", "sib"]);
	const keys = ["fac:d|root", "root|feat", "feat|task", "ghost|task", "task|task"];
	it("members' hierarchy links go, route edges (known endpoints, no loops) come in as springs", () => {
		const links = routeLinkSet(edges, members, keys, (id) => all.has(id));
		assert.deepEqual(links.map((e) => `${e.from}>${e.to}`), ["fac:d>other", "init>sib", "fac:d>root", "root>feat", "feat>task"]);
	});
	it("the simulation runs on that set, and on the normal one again after deselect", () => {
		const nodes = () => [...all].map((id, i) => ({ id, x: i * 10, y: 0 }));
		const linkCount = (es: ReadonlyArray<{ from: string; to: string }>) =>
			(createGraphSimulation(nodes(), es).force("link") as unknown as { links(): unknown[] }).links().length;
		assert.equal(linkCount(routeLinkSet(edges, members, keys, (id) => all.has(id))), 5);
		assert.equal(linkCount(edges), 5);
		assert.equal(routeLinkSet(edges, members, [], (id) => all.has(id)).length, 2);
	});
});

describe("routeLineForce", () => {
	const layout = { root: "fac", target: "t", steps: [["a"], ["b"], ["t"]] };
	const mk = () => [
		{ id: "fac", x: 0, y: 0, vx: 0, vy: 0 },
		{ id: "a", x: 30, y: 90, vx: 0, vy: 0 },
		{ id: "b", x: 250, y: -80, vx: 0, vy: 0 },
		{ id: "t", x: 300, y: 0, vx: 0, vy: 0 },
		{ id: "other", x: 10, y: 10, vx: 0, vy: 0 },
	];
	it("nudges only members, towards their line point, never the two ends; never pins", () => {
		const nodes = mk();
		const f = routeLineForce(layout, 0.1);
		f.initialize(nodes);
		f(1);
		const [fac, a, b, t, other] = nodes;
		assert.ok(a!.vx! > 0 && a!.vy! < 0, "a is pulled toward (100,0)");
		assert.ok(b!.vx! < 0 && b!.vy! > 0, "b is pulled toward (200,0)");
		assert.deepEqual([fac!.vx, fac!.vy, t!.vx, t!.vy, other!.vx, other!.vy], [0, 0, 0, 0, 0, 0]);
		assert.ok(nodes.every((n) => !("fx" in n)));
	});
	it("over simulation ticks members approach the line, and follow a moved end", () => {
		const nodes = mk();
		const sim = createGraphSimulation(nodes, []);
		sim.force("charge", null).force("routeLine", routeLineForce(layout, 0.1));
		const dist = () => Math.abs(nodes[1]!.y!) + Math.abs(nodes[2]!.y!);
		const d0 = dist();
		for (let i = 0; i < 60; i++) sim.alpha(0.3).tick();
		assert.ok(dist() < d0 * 0.5, `${dist()} < ${d0}`);
		nodes[3]!.y = 300; // drag the selected end: the line (and the route) bends
		for (let i = 0; i < 80; i++) sim.alpha(0.3).tick();
		assert.ok(nodes[1]!.y! > 30 && nodes[2]!.y! > 100, "route followed the moved end");
	});
	it("removing the force leaves nothing behind", () => {
		const nodes = mk();
		const sim = createGraphSimulation(nodes, []).force("routeLine", routeLineForce(layout));
		sim.force("routeLine", null);
		assert.equal(sim.force("routeLine"), undefined);
	});
});
