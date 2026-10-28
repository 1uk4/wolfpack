/**
 * Route physics: the pure target layout, the link set the simulation runs on
 * while a route is selected, the weak line force, and the draw list at the
 * positions it is given. Pure — no DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDepDrawList, edgeKey } from "../src/core/dep-draw-list.ts";
import { createGraphSimulation } from "../src/core/layout.ts";
import { ROUTE_LATERAL_SPACING, routeDepSprings, routeFilteredEdges, routeLineForce, routeLinkSet, routeTargetLayout } from "../src/core/route-layout.ts";

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

import { computeWorkRoute as computeEntryRoute } from "../src/core/work-route.ts";
import { toRouteSelection } from "../src/core/dep-route-adapter.ts";
import { routeLinkSet as linkSetForEntry } from "../src/core/route-layout.ts";

describe("route entry edges as springs", () => {
	it("keeps entry edges (and drops other hierarchy links of members)", () => {
		const nodes = [
			{ id: "I", kind: "initiative", stage: "plan", parent: null, dependsOn: [] },
			{ id: "F", kind: "feature", stage: "plan", parent: "I", dependsOn: [] },
			{ id: "a", kind: "task", stage: "plan", parent: "F", dependsOn: [] },
			{ id: "x", kind: "task", stage: "plan", parent: "F", dependsOn: [] },
		];
		const route = computeEntryRoute(nodes, "a", { parentMode: "entry" });
		const sel = toRouteSelection(route, null, "d");
		const hierarchy = [
			{ from: "work:a", to: "work:F" }, { from: "work:x", to: "work:F" },
			{ from: "work:F", to: "work:I" }, { from: "work:I", to: "fac:d" },
		];
		const links = linkSetForEntry(hierarchy, sel.nodes, sel.edges, () => true).map((l) => `${l.from}|${l.to}`);
		for (const k of ["fac:d|work:I", "work:I|work:F", "work:F|work:a"]) assert.ok(links.includes(k), k);
		assert.ok(!links.includes("work:x|work:F"), "non-route child of F is detached from member F");
		assert.ok(!links.includes("work:a|work:F"));
	});
});

describe("route drops member-to-member dependency shortcuts", () => {
	// Feature F depends on feature G: payload edge G>F. The route runs
	// G's terminal task gt -> F -> F's entry task fe; a task dependency
	// gt>fe2 is not on the route though both are members.
	const payload = [
		{ from: "G", to: "F" },
		{ from: "gt", to: "F" },
		{ from: "F", to: "fe" },
		{ from: "gt", to: "fe2" },
		{ from: "gt", to: "outside" },
	];
	const route = {
		nodes: new Set(["G", "F", "gt", "fe", "fe2"]),
		edges: new Set(["gt|F", "F|fe"]),
		parallel: new Set<string>(),
		done: new Set<string>(),
	};
	const factories = [{ members: ["G", "F", "gt", "fe", "fe2", "outside"] }];
	const positions = new Map(["G", "F", "gt", "fe", "fe2", "outside"].map((id, i) => [id, { x: i * 10, y: 0 }]));
	const draw = (r: typeof route | null) =>
		buildDepDrawList({ edges: payload, factories, positions, viewport: { minX: -9, minY: -9, maxX: 99, maxY: 9 }, ratio: 0.3, route: r }).arrows.map(
			(a) => `${a.from}>${a.to}${a.bright ? "!" : ""}`,
		);
	it("G>F and the off-route member dependency are neither drawn nor sprung; route and non-member edges stay", () => {
		assert.deepEqual(draw(route), ["gt>outside", "gt>F!", "F>fe!"]);
		assert.deepEqual(
			routeDepSprings(payload, route.nodes, route.edges).map((e) => `${e.from}>${e.to}`),
			["gt>F", "F>fe", "gt>outside"],
		);
	});
	it("on deselect the G>F edge and spring return", () => {
		assert.ok(draw(null).includes("G>F"));
		assert.ok(draw(null).includes("gt>fe2"));
	});
});

describe("completed route edges are judged by the node they enter", () => {
	const ids = ["I", "S", "a", "b", "c", "p", "q"];
	const positions = new Map(ids.map((id, i) => [id, { x: i * 10, y: 0 }]));
	const route = {
		nodes: new Set(ids),
		edges: new Set(["I|S", "a|b", "b|c", "p|q", "q|c"]),
		parallel: new Set(["p", "q"]),
		// S: a shipped / ready-to-graduate feature; c is unfinished.
		done: new Set(["S", "a", "b", "p", "q"]),
	};
	const arrows = buildDepDrawList({
		edges: [],
		factories: [{ members: ids }],
		positions,
		viewport: { minX: -9, minY: -9, maxX: 99, maxY: 9 },
		ratio: 0.3,
		route,
	}).arrows;
	const get = (from: string, to: string) => arrows.find((a) => a.from === from && a.to === to)!;
	it("an edge entering a done node is done, even from an unfinished tail", () => {
		assert.equal(get("I", "S").done, true, "initiative -> shipped feature");
		assert.equal(get("a", "b").done, true);
		assert.equal(get("p", "q").done, true);
	});
	it("done -> unfinished stays bright (not done)", () => {
		assert.equal(get("b", "c").done, undefined);
		assert.equal(get("b", "c").bright, true);
	});
	it("parallel hue is only for unfinished parallel steps", () => {
		assert.equal(get("p", "q").parallel, undefined);
		assert.equal(get("q", "c").parallel, undefined);
	});
	it("hidden (collapsed) ends are not drawn", () => {
		const hidden = buildDepDrawList({
			edges: [{ from: "a", to: "b" }], factories: [{ members: ids }], positions,
			viewport: { minX: -9, minY: -9, maxX: 99, maxY: 9 }, ratio: 0.3, route: { ...route, hidden: new Set(["a"]) },
		}).arrows;
		assert.ok(!hidden.some((a) => a.from === "a" || a.to === "a"));
	});
});

describe("route done styling constants", () => {
	it("one muted grey for done edges/nodes; node opacity sits between route and background", async () => {
		const palette = await import("../src/core/dep-palette.ts");
		assert.match(palette.ROUTE_DONE_COLOR, /^#[0-9a-f]{6}$/);
		const hex = palette.ROUTE_DONE_COLOR.slice(1).match(/../g)!.map((h) => parseInt(h, 16));
		assert.ok(Math.max(...hex) - Math.min(...hex) < 40, "grey: channels close together");
		assert.equal("PARALLEL_DONE_COLOR" in palette, false);
		assert.ok(palette.DEP_STYLE.doneWidth < palette.DEP_STYLE.routeWidth);
		assert.ok(palette.DEP_STYLE.routeDoneNodeAlpha > 0.3 && palette.DEP_STYLE.routeDoneNodeAlpha < 1);
	});
	it("the selection marks done nodes (shipped feature, ready-to-graduate feature)", () => {
		const nodes = [
			{ id: "I", kind: "initiative", stage: "plan", parent: null, dependsOn: [] },
			{ id: "S", kind: "feature", stage: "in_build", parent: "I", dependsOn: [] },
			{ id: "s1", kind: "task", stage: "shipped", parent: "S", dependsOn: [] },
			{ id: "T", kind: "feature", stage: "plan", parent: "I", dependsOn: ["S"] },
			{ id: "t1", kind: "task", stage: "plan", parent: "T", dependsOn: [] },
		];
		const sel = toRouteSelection(computeEntryRoute(nodes, "t1"), null, "d");
		assert.ok(sel.done.has("work:S") && sel.done.has("work:s1"));
		assert.ok(!sel.done.has("work:t1"));
	});
});

describe("physics on the collapsed route", () => {
	const nodes = [
		{ id: "I", kind: "initiative", stage: "plan", parent: null, dependsOn: [] },
		{ id: "S", kind: "feature", stage: "shipped", parent: "I", dependsOn: [] },
		{ id: "s1", kind: "task", stage: "shipped", parent: "S", dependsOn: [] },
		{ id: "s2", kind: "task", stage: "shipped", parent: "S", dependsOn: ["s1"] },
		{ id: "T", kind: "feature", stage: "plan", parent: "I", dependsOn: ["S"] },
		{ id: "t1", kind: "task", stage: "plan", parent: "T", dependsOn: [] },
	];
	it("the link set springs the feature in place of its hidden tasks", () => {
		const route = computeEntryRoute(nodes, "t1", { collapseDoneFeatures: true, parentMode: "entry" });
		const sel = toRouteSelection(route, null, "d");
		const hierarchy = [{ from: "work:s1", to: "work:S" }, { from: "work:s2", to: "work:S" }, { from: "work:S", to: "work:I" }];
		const links = linkSetForEntry(hierarchy, sel.nodes, sel.edges, () => true).map((l) => `${l.from}|${l.to}`);
		assert.ok(links.includes("work:S|work:T"));
		assert.ok(!links.some((l) => l.includes("work:s1") || l.includes("work:s2")));
		assert.deepEqual(sel.layout!.steps.flat().filter((id) => id === "work:s1" || id === "work:s2"), []);
		assert.deepEqual([...sel.hidden!].sort(), ["work:s1", "work:s2"]);
		assert.equal(sel.collapsed!.get("work:S"), 2);
	});
});

describe("route exit edges as springs", () => {
	it("keeps exit edges (task -> feature -> initiative) and drops other hierarchy links of members", () => {
		const nodes = [
			{ id: "I", kind: "initiative", stage: "plan", parent: null, dependsOn: [] },
			{ id: "F", kind: "feature", stage: "plan", parent: "I", dependsOn: [] },
			{ id: "a", kind: "task", stage: "plan", parent: "F", dependsOn: [] },
			{ id: "x", kind: "task", stage: "plan", parent: "F", dependsOn: [] },
		];
		const route = computeEntryRoute(nodes, "a", { parentMode: "exit" });
		assert.ok(route.edges.filter((e) => e.exit).length === 2);
		const sel = toRouteSelection(route, null, "d");
		const hierarchy = [
			{ from: "work:a", to: "work:F" }, { from: "work:x", to: "work:F" },
			{ from: "work:F", to: "work:I" }, { from: "work:I", to: "fac:d" },
		];
		const links = linkSetForEntry(hierarchy, sel.nodes, sel.edges, () => true).map((l) => `${l.from}|${l.to}`);
		for (const k of ["fac:d|work:a", "work:a|work:F", "work:F|work:I"]) assert.ok(links.includes(k), k);
		assert.ok(!links.includes("work:x|work:F"));
		assert.ok(!links.includes("work:I|fac:d"));
	});
});
