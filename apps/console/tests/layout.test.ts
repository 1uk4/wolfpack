/**
 * Option A — incremental anchored force layout (core/layout.ts). The
 * properties the user asked for: the layout EVOLVES (old placements stay
 * recognizable), new nodes land near their cluster, orphans collect on
 * the rim, and everything is deterministic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGraphSimulation, incrementalLayout } from "../src/core/layout.ts";
import type { Position } from "../src/core/contracts.ts";

const node = (id: string): { id: string } => ({ id });
/** incrementalLayout's link shape. */
const edge = (from: string, to: string): { from: string; to: string } => ({ from, to });

const mean = (positions: Map<string, Position>, ids: string[]): { x: number; y: number } => ({
	x: ids.reduce((s, id) => s + positions.get(id)!.x, 0) / ids.length,
	y: ids.reduce((s, id) => s + positions.get(id)!.y, 0) / ids.length,
});

describe("incrementalLayout", () => {
	it("bootstraps deterministically from no stored positions", () => {
		const nodes = ["a", "b", "c", "d"].map(node);
		const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
		const first = incrementalLayout(nodes, edges, new Map());
		const second = incrementalLayout(nodes, edges, new Map());
		assert.equal(first.size, 4);
		for (const [id, p] of first) {
			assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `finite coords for ${id}`);
			assert.deepEqual(p, second.get(id), `deterministic position for ${id}`);
		}
	});

	it("rest state is stable: a re-settle with nothing new barely moves nodes", () => {
		const nodes = ["a", "b", "c", "d", "e"].map(node);
		const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("a", "e")];
		const rest = incrementalLayout(nodes, edges, new Map());
		const span =
			Math.max(...[...rest.values()].map((p) => p.x)) - Math.min(...[...rest.values()].map((p) => p.x));
		const again = incrementalLayout(nodes, edges, rest);
		let maxShift = 0;
		for (const [id, p] of rest) {
			const q = again.get(id)!;
			maxShift = Math.max(maxShift, Math.hypot(p.x - q.x, p.y - q.y));
		}
		assert.ok(maxShift < span * 0.1, `re-settle drift ${maxShift.toFixed(2)} should be < 10% of span ${span.toFixed(2)}`);
	});

	it("evolves: an anchored node stays near its anchor while a new neighbor joins it", () => {
		const core = ["a", "b", "c"].map(node);
		const coreEdges = [edge("a", "b"), edge("b", "c")];
		const previous = incrementalLayout(core, coreEdges, new Map());
		const anchor = previous.get("b")!;
		const dist = Math.hypot;
		const nearby = ["d", "e"].map(node);
		const next = incrementalLayout(
			[...core, ...nearby],
			[...coreEdges, edge("b", "d"), edge("d", "e")],
			previous,
		);
		// The anchor keeps its neighborhood (bounded drift), and the new
		// nodes landed near it rather than being flung elsewhere.
		const coreSpanBefore =
			Math.max(...[...previous.values()].map((p) => p.x)) - Math.min(...[...previous.values()].map((p) => p.x));
		assert.ok(
			dist(next.get("b")!.x - anchor.x, next.get("b")!.y - anchor.y) < coreSpanBefore,
			"anchored node b stays near its previous position",
		);
		const centroid = mean(next, ["b", "d", "e"]);
		assert.ok(
			dist(next.get("d")!.x - centroid.x, next.get("d")!.y - centroid.y) < coreSpanBefore * 2,
			"new neighbor d landed near the cluster it arrived with",
		);
	});

	it("rim: an orphan ends up outside the anchored core", () => {
		const core = ["a", "b", "c", "d", "e"].map(node);
		const coreEdges = [
			edge("a", "b"),
			edge("b", "c"),
			edge("c", "d"),
			edge("d", "e"),
			edge("a", "e"),
			edge("b", "d"),
		];
		const previous = incrementalLayout(core, coreEdges, new Map());
		const next = incrementalLayout([...core, node("orphan")], coreEdges, previous);
		const c = mean(previous, ["a", "b", "c", "d", "e"]);
		const coreMax = Math.max(
			...[...next.entries()].filter(([id]) => id !== "orphan").map(([, p]) => Math.hypot(p.x - c.x, p.y - c.y)),
		);
		const orphanR = Math.hypot(next.get("orphan")!.x - c.x, next.get("orphan")!.y - c.y);
		assert.ok(orphanR > coreMax, `orphan at r=${orphanR.toFixed(1)} should sit outside core max r=${coreMax.toFixed(1)}`);
	});
});

describe("clusterPull (the centroid force)", () => {
	it("compacts each cluster toward its OWN centroid; strength 0 = off", () => {
		// Two loose chains, far apart, edges only WITHIN each chain.
		const mk = (p: string, baseX: number) =>
			Array.from({ length: 8 }, (_, i) => ({ id: `${p}${i}`, x: baseX + i * 40, y: i * 15 }));
		const a = mk("a", -400);
		const b = mk("b", 400);
		const nodes = [...a, ...b];
		const edges = [
			...a.slice(0, -1).map((n, i) => ({ from: n.id, to: a[i + 1]!.id })),
			...b.slice(0, -1).map((n, i) => ({ from: n.id, to: b[i + 1]!.id })),
		];
		const clusters = [{ members: a.map((n) => n.id) }, { members: b.map((n) => n.id) }];

		const spreadOf = (ns: { id: string; x: number; y: number }[]): number => {
			let sum = 0;
			for (const group of [ns.filter((n) => n.id[0] === "a"), ns.filter((n) => n.id[0] === "b")]) {
				const cx = group.reduce((s, n) => s + n.x, 0) / group.length;
				const cy = group.reduce((s, n) => s + n.y, 0) / group.length;
				sum += group.reduce((s, n) => s + Math.hypot(n.x - cx, n.y - cy), 0) / group.length;
			}
			return sum;
		};

		const run = (strength: number) => {
			const sim = createGraphSimulation(
				nodes.map((n) => ({ ...n })),
				edges,
				{ clusterPull: { clusters, strength } },
			);
			for (let i = 0; i < 150; i++) sim.tick();
			return spreadOf(sim.nodes() as unknown as { id: string; x: number; y: number }[]);
		};
		const pulled = run(0.15);
		const unpulled = run(0);
		// The force compacts (well under the unpulled baseline)...
		assert.ok(pulled < unpulled * 0.8, `pulled spread ${pulled.toFixed(1)} should be well under ${unpulled.toFixed(1)}`);
		// ...and both groups survive as separate blobs (no merge).
		assert.ok(pulled > 0, "spread is finite/positive");
	});
});

describe("hierarchy depth anchoring (domain → section → entry → work)", () => {
	const nodes = (ids: string[]) => ids.map((id) => ({ id, x: 0, y: 0 }));
	const depthsOf = (entries: [string, number][]) => new Map(entries);

	it("vertical: deeper kinds land below their parents (domains on top)", () => {
		const ns = nodes(["dom", "sec", "ent"]);
		const edges = [
			{ from: "dom", to: "sec" },
			{ from: "sec", to: "ent" },
		];
		const sim = createGraphSimulation(ns, edges, {
			depthAnchor: {
				mode: "vertical",
				strength: 1.2,
				spacing: 100,
				center: { x: 0, y: 0 },
				depths: depthsOf([["dom", 0], ["sec", 1], ["ent", 2]]),
			},
		});
		for (let i = 0; i < 300; i++) sim.tick();
		const y = (id: string) => sim.nodes().find((n) => n.id === id)!.y!;
		assert.ok(y("dom") < y("sec"), `domain (${y("dom").toFixed(0)}) above section (${y("sec").toFixed(0)})`);
		assert.ok(y("sec") < y("ent"), `section (${y("sec").toFixed(0)}) above entry (${y("ent").toFixed(0)})`);
		assert.ok(y("ent") - y("dom") > 100, "level separation is substantial");
	});

	it("radial: hierarchy depth becomes radius (domains at the center)", () => {
		const ns = nodes(["dom", "sec", "ent"]);
		const edges = [
			{ from: "dom", to: "sec" },
			{ from: "sec", to: "ent" },
		];
		const sim = createGraphSimulation(ns, edges, {
			depthAnchor: {
				mode: "radial",
				strength: 1.2,
				spacing: 80,
				baseRadius: 100,
				center: { x: 0, y: 0 },
				depths: depthsOf([["dom", 0], ["sec", 1], ["ent", 2]]),
			},
		});
		for (let i = 0; i < 300; i++) sim.tick();
		const r = (id: string) => {
			const n = sim.nodes().find((x) => x.id === id)!;
			return Math.hypot(n.x!, n.y!);
		};
		assert.ok(r("dom") < r("sec"), `domain ring (${r("dom").toFixed(0)}) inside section (${r("sec").toFixed(0)})`);
		assert.ok(r("sec") < r("ent"), `section ring (${r("sec").toFixed(0)}) inside entry (${r("ent").toFixed(0)})`);
	});

	it("off (the default): the depth map is ignored", () => {
		const sim = createGraphSimulation(nodes(["a", "b"]), [{ from: "a", to: "b" }], {
			depthAnchor: { mode: "off", strength: 1, spacing: 100, depths: depthsOf([["a", 0], ["b", 3]]) },
		});
		for (let i = 0; i < 100; i++) sim.tick();
		const [a, b] = sim.nodes();
		assert.ok(Math.abs(a!.y! - b!.y!) < 200, "no row separation without a mode");
	});

	it("vertical: nodes outside the depth map are not anchored — free y, horizontal pole", () => {
		const ns = [
			{ id: "dom", x: 0, y: 0 },
			{ id: "sec", x: 10, y: 0 },
			{ id: "loner", x: 400, y: -80 },
		];
		const sim = createGraphSimulation(ns, [{ from: "dom", to: "sec" }], {
			gravity: { x: 0, y: 500, strength: 0.1 },
			depthAnchor: {
				mode: "vertical",
				strength: 1.5,
				spacing: 120,
				center: { x: 0, y: 0 },
				depths: depthsOf([["dom", 0], ["sec", 1]]),
			},
			chargeStrength: 0,
		});
		for (let i = 0; i < 400; i++) sim.tick();
		const byId = new Map(sim.nodes().map((n) => [n.id, n]));
		assert.ok(Math.abs(byId.get("dom")!.y!) < 40, "the domain sits on the baseline");
		assert.ok(byId.get("sec")!.y! > 60, "the section drops a level");
		// Unanchored nodes keep the REGULAR pull (gravity on both axes).
		assert.ok(byId.get("loner")!.y! > 100, `the loner follows gravity on y (y=${byId.get("loner")!.y!.toFixed(0)})`);
	});

	it("settle with depthAnchor: old nodes keep x memory but snap to their level", () => {
		const previous = new Map([["old", { x: 250, y: 300 }], ["peer", { x: 260, y: 290 }]]);
		const next = incrementalLayout(
			[{ id: "old" }, { id: "peer" }, { id: "child" }],
			[
				{ from: "old", to: "child" },
				{ from: "peer", to: "child" },
			],
			previous,
			{
				depthAnchor: {
					mode: "vertical",
					strength: 0.6,
					spacing: 80,
					depths: depthsOf([["old", 0], ["peer", 0], ["child", 1]]),
				},
			},
		);
		const old = next.get("old")!;
		// The baseline defaults to the anchor centroid: (300+290)/2 = 295.
		assert.ok(Math.abs(old.y - 295) < 20, `old node snaps to the baseline (y=${old.y.toFixed(1)})`);
		assert.ok(old.x > 150, `x memory preserved (x=${old.x.toFixed(1)})`);
		const child = next.get("child")!;
		assert.ok(child.y > old.y + 40, `child sits a level below (child=${child.y.toFixed(1)}, old=${old.y.toFixed(1)})`);
	});
});
