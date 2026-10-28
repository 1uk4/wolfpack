/** True work depth + subtree-sized hierarchy springs (feature: graph work depth). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCanvasData } from "../src/core/kb-graph-model.ts";
import { WORK_LINK, createGraphSimulation, incrementalLayout, subtreeLinkLength } from "../src/core/layout.ts";
import { routeLinkSet } from "../src/core/route-layout.ts";
import type { KbGraph, KbGraphNode } from "../src/core/kb.ts";

const DEPTH = { domain: 0, factory: 1, section: 1, entry: 2, work: 3, "den-topic": 4 } as const;
const n = (id: string, kind: KbGraphNode["kind"]): KbGraphNode => ({ id, kind, label: id, depth: DEPTH[kind], domain: "d" });
const h = (source: string, target: string) => ({ source, target, kind: "hierarchy" as const });

/** dom → fac → init → feat(11 tasks) / feat2(2 tasks); loose feature `lf`; entry under dom. */
function graph(): KbGraph {
	const tasks = (f: string, c: number) => Array.from({ length: c }, (_, i) => `work:${f}t${i}`);
	const big = tasks("big", 11);
	const small = tasks("small", 2);
	const nodes = [
		n("dom:d", "domain"), n("fac:d", "factory"), n("ent:e", "entry"), n("work:init", "work"), n("work:big", "work"),
		n("work:small", "work"), n("work:lf", "work"), ...[...big, ...small].map((id) => n(id, "work")),
	];
	const edges = [
		h("dom:d", "fac:d"), h("dom:d", "ent:e"), h("fac:d", "work:init"), h("fac:d", "work:lf"),
		h("work:init", "work:big"), h("work:init", "work:small"),
		...big.map((t) => h("work:big", t)), ...small.map((t) => h("work:small", t)),
	];
	return { nodes, edges, domains: [{ name: "d", label: "d" }] } as unknown as KbGraph;
}

describe("work depth", () => {
	const data = toCanvasData(graph(), { groupBy: "domain" });
	it("increases along partOf from the Factory", () => {
		const d = data.depths;
		assert.equal(d.get("fac:d"), 1);
		assert.equal(d.get("work:init"), 2);
		assert.equal(d.get("work:big"), 3);
		assert.equal(d.get("work:bigt0"), 4);
	});
	it("loose features sit at 2; KB depths unchanged", () => {
		assert.equal(data.depths.get("work:lf"), 2);
		assert.equal(data.depths.get("dom:d"), 0);
		assert.equal(data.depths.get("ent:e"), 2);
	});
});

describe("work link lengths", () => {
	const data = toCanvasData(graph(), { groupBy: "domain" });
	const L = data.linkLengths;
	it("grow with the subtree; leaves are short", () => {
		assert.equal(L.get("work:big|work:bigt0"), WORK_LINK.base);
		assert.ok(L.get("work:init|work:big")! > L.get("work:init|work:small")!);
		assert.ok(L.get("fac:d|work:init")! > L.get("work:init|work:big")!);
	});
	it("KB links have no entry (unchanged)", () => {
		assert.equal(L.has("dom:d|ent:e"), false);
		assert.equal(L.has("dom:d|fac:d"), false);
	});
	it("is capped", () => {
		assert.equal(subtreeLinkLength(1e6), WORK_LINK.cap);
		assert.equal(subtreeLinkLength(0), WORK_LINK.base);
	});
	it("route-swapped link sets keep the per-link distances", () => {
		const set = routeLinkSet(data.edges, new Set(["work:small"]), ["work:lf|work:bigt0"], () => true);
		const kept = set.find((e) => e.from === "work:init" && e.to === "work:big")!;
		assert.ok(kept);
		const sim = createGraphSimulation(
			data.nodes.map((x) => ({ id: x.id, x: Math.random() * 10, y: Math.random() * 10 })),
			set,
			{ linkLengths: L },
		);
		const links = (sim.force("link") as any).links() as Array<{ source: { id: string }; target: { id: string } }>;
		const dist = (a: string, b: string) => (sim.force("link") as any).distance()(links.find((l) => l.source.id === a && l.target.id === b));
		assert.equal(dist("work:init", "work:big"), L.get("work:init|work:big"));
		assert.equal(dist("work:lf", "work:bigt0"), 40); // route edge: default
	});
});

describe("settled layout", () => {
	it("a big feature's tasks do not overlap", () => {
		const data = toCanvasData(graph(), { groupBy: "domain" });
		const pos = incrementalLayout(data.nodes, data.edges, new Map(), { linkLengths: data.linkLengths });
		const ts = [...pos].filter(([id]) => id.startsWith("work:bigt"));
		assert.equal(ts.length, 11);
		let min = Infinity;
		for (let i = 0; i < ts.length; i++)
			for (let j = i + 1; j < ts.length; j++) min = Math.min(min, Math.hypot(ts[i]![1].x - ts[j]![1].x, ts[i]![1].y - ts[j]![1].y));
		assert.ok(min > 8, `min task separation ${min}`);
	});
});
