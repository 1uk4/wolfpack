/**
 * Dependency-route rendering: the draw-list builder, work node style (stage
 * fill + blocked ring), Factory-only layout springs. Pure — no DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDepDrawList, edgeKey, type DepRouteSelection } from "../src/core/dep-draw-list.ts";
import { DEP_ARROW_MAX_RATIO } from "../src/core/dep-palette.ts";
import { blockedWorkIds, factorySprings, nodeStyle, toCanvasData } from "../src/core/kb-graph-model.ts";
import { createGraphSimulation } from "../src/core/layout.ts";
import type { KbGraph, KbGraphNode } from "../src/core/kb.ts";

const pos = (o: Record<string, [number, number]>) => new Map(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));
const positions = pos({ a: [0, 0], b: [10, 0], c: [20, 0], far: [5000, 5000], x: [3, 3] });
const base = {
	edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
	factories: [{ members: ["a", "b", "c"] }],
	positions,
	viewport: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
	ratio: 0.3,
};
const route = (p: Partial<DepRouteSelection>): DepRouteSelection => ({ nodes: new Set(), edges: new Set(), parallel: new Set(), done: new Set(), ...p });

describe("buildDepDrawList", () => {
	it("draws nothing above the zoom threshold, everything faint at or below it", () => {
		assert.deepEqual(buildDepDrawList({ ...base, ratio: DEP_ARROW_MAX_RATIO + 0.01 }).arrows, []);
		const at = buildDepDrawList({ ...base, ratio: DEP_ARROW_MAX_RATIO }).arrows;
		assert.equal(at.length, 2);
		assert.ok(at.every((a) => !a.bright));
	});
	it("only edges inside a Factory region that is in view", () => {
		assert.deepEqual(buildDepDrawList({ ...base, viewport: { minX: 1000, minY: 1000, maxX: 2000, maxY: 2000 } }).arrows, []);
		const out = buildDepDrawList({ ...base, edges: [...base.edges, { from: "a", to: "x" }, { from: "b", to: "far" }] }).arrows;
		assert.deepEqual(out.map((a) => edgeKey(a.from, a.to)), ["a|b", "b|c"], "x and far are in no Factory");
	});
	it("search visibility hides edges with a hidden endpoint", () => {
		const out = buildDepDrawList({ ...base, visible: new Set(["a", "b"]) }).arrows;
		assert.deepEqual(out.map((a) => edgeKey(a.from, a.to)), ["a|b"]);
	});
	it("route edges are bright and last; unknown route edges inside the Factory are added", () => {
		const out = buildDepDrawList({ ...base, route: route({ edges: new Set(["a|b", "a|c"]) }) }).arrows;
		assert.deepEqual(out.map((a) => [edgeKey(a.from, a.to), a.bright]), [["b|c", false], ["a|b", true], ["a|c", true]]);
	});
	it("a route does not bypass the zoom gate", () => {
		assert.deepEqual(buildDepDrawList({ ...base, ratio: 1, route: route({ edges: new Set(["a|b"]) }) }).arrows, []);
	});
});

const n = (id: string, stage?: string, kind: KbGraphNode["kind"] = "work"): KbGraphNode => ({ id, kind, label: id, depth: 3, domain: "d", ...(stage ? { stage } : {}) });

describe("work node style", () => {
	it("fill shows the stage: shipped dim disc, in_build bright disc, plan outlined", () => {
		assert.deepEqual([nodeStyle(n("w", "shipped")).shape, nodeStyle(n("w", "shipped")).dim], ["disc", true]);
		assert.deepEqual([nodeStyle(n("w", "in_build")).shape, nodeStyle(n("w", "in_build")).dim], ["disc", false]);
		for (const s of ["plan", "idea", "approved", undefined]) {
			assert.equal(nodeStyle(n("w", s)).shape, "ring");
			assert.equal(nodeStyle(n("w", s)).dim, false);
		}
	});
	it("blocked is a ring flag on work only", () => {
		assert.equal(nodeStyle(n("w", "plan"), true).blocked, true);
		assert.equal(nodeStyle(n("w", "plan")).blocked, false);
		assert.equal(nodeStyle(n("e", undefined, "entry"), true).blocked, false);
	});
	const graph = (stages: Record<string, string>, deps: Array<[string, string]>): KbGraph =>
		({
			nodes: Object.entries(stages).map(([id, s]) => n(id, s)),
			edges: deps.map(([s, t]) => ({ source: s, target: t, kind: "dependsOn" as const })),
			domains: [{ name: "d", label: "d" }],
		}) as unknown as KbGraph;
	it("blocked = any dependsOn prerequisite (task or feature) not shipped or archived", () => {
		const g = graph({ t1: "plan", t2: "shipped", t3: "archived", t4: "in_build", t5: "plan", f: "plan" }, [["t1", "t2"], ["t1", "t4"], ["t5", "t2"], ["t5", "t3"], ["f", "t1"]]);
		assert.deepEqual([...blockedWorkIds(g)].sort(), ["f", "t1"]);
	});
	it("toCanvasData carries blocked on nodes and depEdges prerequisite -> dependent", () => {
		const g = graph({ a: "plan", b: "plan" }, [["b", "a"]]);
		const data = toCanvasData(g, { groupBy: "domain" });
		assert.equal(data.nodes.find((x) => x.id === "b")!.blocked, true);
		assert.equal(data.nodes.find((x) => x.id === "a")!.blocked, false);
		assert.deepEqual(data.depEdges, [{ from: "a", to: "b" }]);
	});
});

describe("dependency springs", () => {
	it("factorySprings keeps only edges inside one Factory", () => {
		const out = factorySprings([{ from: "a", to: "b" }, { from: "a", to: "ent" }, { from: "b", to: "z" }], [{ members: ["fac", "a", "b"] }, { members: ["z"] }]);
		assert.deepEqual(out, [{ from: "a", to: "b" }]);
	});
	it("a dependency spring pulls its endpoints together", () => {
		const mk = () => [{ id: "a", x: -300, y: 0 }, { id: "b", x: 300, y: 0 }, { id: "k1", x: -300, y: 200 }, { id: "k2", x: 300, y: 200 }];
		const run = (springs: boolean) => {
			const sim = createGraphSimulation(mk(), [], { depSprings: springs ? { edges: [{ from: "a", to: "b" }], strength: 0.3 } : undefined });
			for (let i = 0; i < 60; i++) sim.tick();
			const m = new Map((sim.nodes() as Array<{ id: string; x: number; y: number }>).map((p) => [p.id, p]));
			const d = (p: string, q: string) => Math.hypot(m.get(p)!.x - m.get(q)!.x, m.get(p)!.y - m.get(q)!.y);
			return { ab: d("a", "b"), kk: d("k1", "k2") };
		};
		const on = run(true);
		const off = run(false);
		assert.ok(on.ab < off.ab * 0.8, `springs shrink a-b: ${on.ab} vs ${off.ab}`);
	});
	it("no springs given = identical simulation", () => {
		const mk = () => [{ id: "a", x: -100, y: 0 }, { id: "b", x: 100, y: 0 }];
		const r = (o: object) => {
			const sim = createGraphSimulation(mk(), [{ from: "a", to: "b" }], o);
			for (let i = 0; i < 30; i++) sim.tick();
			return (sim.nodes() as Array<{ x: number }>).map((p) => p.x);
		};
		assert.deepEqual(r({}), r({ depSprings: { edges: [] } }));
	});
});
