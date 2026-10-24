import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	PlanDiagram,
	blockLayout,
	topoFor,
	edgePathD,
	wrapTitle,
	GAP_X,
	NODE_H,
	NODE_W_MIN,
	nodeWidth,
	estimateLineWidth,
} from "../components/plan-block.tsx";

// The DAG diagram (inert in the console today): the pure layered layout and
// the static render of the diagram itself.

const CHAIN = {
	nodes: [
		{ id: "a", title: "Alpha node" },
		{ id: "b", title: "Beta node" },
		{ id: "c", title: "Gamma node" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
};

describe("plan block layout (pure)", () => {
	it("layers a chain top-down, one node per depth row", () => {
		const { order, depth } = topoFor(CHAIN.nodes, CHAIN.edges);
		assert.deepEqual(order.map((n) => n.id), ["a", "b", "c"]);
		assert.equal(depth.get("c"), 2);
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		// Text-first sizing (owner, plan-hug round 2026-10-07): these short
		// titles hug to the minimum — no more fixed 160px slabs.
		const W = nodeWidth(wrapTitle("Alpha node"));
		assert.equal(W, NODE_W_MIN); // est ≈ 50 → floored at the min
		// All three short titles floor — the extent is the floor itself.
		assert.equal(nodeWidth(wrapTitle("Gamma node")), NODE_W_MIN); // est ≈ 59.9
		assert.equal(layout.width, NODE_W_MIN);
		assert.equal(layout.height, 3 * NODE_H + 2 * 48);
		assert.equal(layout.nodeW.get("a"), W);
	});

	it("centers same-depth nodes over the widest row; tolerates dangling edges", () => {
		const nodes = [
			{ id: "r", title: "Root" },
			{ id: "x", title: "Left" },
			{ id: "y", title: "Right" },
		];
		const layout = blockLayout(nodes, [
			{ from: "r", to: "x" },
			{ from: "r", to: "y" },
			{ from: "ghost", to: "r" }, // dangling: ignored defensively
		]);
		const W = nodeWidth(wrapTitle("Root"));
		assert.equal(layout.width, 2 * W + GAP_X);
		// Root centered over its two children: (2*W+GAP - W)/2
		assert.equal(layout.x.get("r"), (2 * W + GAP_X - W) / 2);
		assert.ok(layout.x.get("x") === 0 && layout.x.get("y") === W + GAP_X);
	});

	it("edgePathD draws dagre's route through curveBasis — mouth pulled back from the border", () => {
		// Straight 3-point route (source border → mid → target border): the
		// basis curve starts exactly at the border point; the END pulls
		// back by HEAD_TIP_OVERHANG + the docking gap (92 − 2.359 − 2.667) so
		// the head's TIP floats 2.67 short of the border with its mouth at
		// the path's end, on a straight shaft (owner, rounds 11–12; the head
		// + gap scaled ⅔ with the 1px lines, 2026-09-26).
		const d = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }]);
		assert.ok(d.startsWith("M80,44"), "starts at the source border point");
		assert.ok(d.endsWith("L80,86.974"), "mouth pulled back; tip floats 2.67 off the border");
		// The whole run stays on-axis (every x is 80): a collinear route
		// renders straight — the shaft stub never bends a straight edge.
		const xs = [...d.matchAll(/(?:[MLC]|,)(-?[\d.]+),/g)].map((m) => m[1]);
		assert.ok(xs.length > 0 && xs.every((v) => v === "80"), "collinear route renders on-axis");
		// A perpendicular entry with the target box is the SAME geometry.
		const pd = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }], { x: 0, y: 92, w: 160, h: 44 });
		assert.equal(pd, d);
	});

	it("edgePathD clamps the entry to ±40° of the face perpendicular (owner, round 14)", () => {
		const box = { x: 20, y: 100, w: 160, h: 44 };
		// A 60° tilt into the top face swings to the 40° cone edge: the
		// mouth lands at (97.726, 93.289) and the final segment runs at
		// exactly 40° (Δx/Δy = tan 40°). The tip floats DOCK_GAP (4) off the
		// face along the normal: border (100,100) → tip (100,96).
		const clamped = edgePathD([{ x: 70, y: 70 }, { x: 100, y: 100 }], box);
		assert.ok(clamped.endsWith("L98.484,95.526"), "swung to the cone edge");
		// final L's from-point is the previous number pair; recompute direction
		const nums = [...clamped.matchAll(/(-?[\d.]+)/g)].map((m) => Number(m[1]));
		const ax = nums[nums.length - 4]!;
		const ay = nums[nums.length - 3]!;
		const bx = nums[nums.length - 2]!;
		const by = nums[nums.length - 1]!;
		assert.ok(Math.abs((bx - ax) / (by - ay) - Math.tan((40 * Math.PI) / 180)) < 0.01, "40° cone edge");
		// Tip = mouth + u'·overhang floats 2.67 above the face.
		const tipY = by + 0.766 * 2.359;
		assert.ok(Math.abs(tipY - 97.333) < 0.01, "docking gap along the face normal");
		// A shallow (~9.5°) tilt is WITHIN the limit: no swing.
		const free = edgePathD([{ x: 90, y: 40 }, { x: 100, y: 100 }], box);
		assert.ok(free.endsWith("L99.612,95.006"), "unclamped within the cone");
	});

	it("wrapTitle wraps greedily and NEVER drops content (boxes grow instead)", () => {
		assert.deepEqual(wrapTitle("Chain rule intuition"), ["Chain rule intuition"]); // well under — one line
		assert.deepEqual(wrapTitle("Chain rule intuition and fluency"), [
			"Chain rule intuition and", // 24 — appending "fluency" would pass 28
			"fluency",
		]);
		// Oversized word hard-chunked, nothing lost (owner, round 7).
		assert.deepEqual(wrapTitle("supercalifragilisticexpialidocious word"), [
			"supercalifragilisticexpialid", // the chunker cuts AT maxChars
			"ocious word",
		]);
		assert.deepEqual(wrapTitle("supercalifragilistic"), ["supercalifragilistic"]); // exactly 20 — fits
	});

	it("nodeWidth hugs the wrapped text (the box grows WITH its lines)", () => {
		// Short titles floor at the min; wide ones size to the widest line.
		// Per-char-CLASS estimate (owner follow-up: the flat px/char rate
		// overshot the rendered width — invisible slack beside the text).
		assert.equal(nodeWidth(["supercalifragilistic"]), 117); // est ≈ 85 + 2×16
		assert.equal(nodeWidth(wrapTitle("Symmetry and orthogonal complements")), 149);
		// The hug is symmetric padding — 16 a side, the SAME as the vertical
		// (44−12)/2 — and never below the floor.
		assert.ok(nodeWidth(["a"]) === NODE_W_MIN);
		assert.ok(Math.abs(estimateLineWidth("The normal-form ladder") - 106.3) < 0.5);
	});
});

describe("dag diagram render", () => {
	it("renders every node title and one arrow path per edge", () => {
		const html = renderToStaticMarkup(
			<PlanDiagram nodes={CHAIN.nodes} edges={CHAIN.edges} statusOf={() => "upcoming"} markerId="m1" pad={8} monochrome />,
		);
		for (const title of ["Alpha node", "Beta node", "Gamma node"]) assert.ok(html.includes(title), title);
		assert.equal((html.match(/<path /g) ?? []).length >= 2, true, "an arrow path per edge");
	});
});
