/** layoutGraph: the plain layout is unchanged without `slim`; slivers pack tighter. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutGraph } from "../src/core/graph-layout.ts";

const ids = (...a: string[]) => a.map((id) => ({ id }));
const W = 148;
const H = 56;
const GX = 36;
const GY = 12;

describe("layoutGraph without slim", () => {
	it("an empty graph is 0 by 0", () => {
		const l = layoutGraph([], []);
		assert.equal(`${l.width}x${l.height}:${l.nodes.length}:${l.edges.length}`, "0x0:0:0");
	});
	it("a chain and a fork keep the fixed grid", () => {
		const l = layoutGraph(ids("a", "b", "c"), [{ from: "b", to: "a" }, { from: "c", to: "a" }]);
		const at = (id: string) => l.nodes.find((n) => n.id === id)!;
		assert.equal(`${at("a").x},${at("a").y}`, "0,0");
		assert.equal(`${at("b").x},${at("b").y}`, `${W + GX},0`);
		assert.equal(`${at("c").x},${at("c").y}`, `${W + GX},${H + GY}`);
		assert.equal(l.width, 2 * W + GX);
		assert.equal(l.height, 2 * H + GY);
		assert.equal(l.nodes.every((n) => n.width === W && n.height === H), true);
		const e = l.edges[0]!;
		assert.equal(`${e.x1},${e.y1},${e.x2},${e.y2}`, `${W},${H / 2},${W + GX},${H / 2}`);
	});
	it("a rank gap (c depends on b depends on a, d alone) still spans columns", () => {
		const l = layoutGraph(ids("a", "b", "c", "d"), [{ from: "b", to: "a" }, { from: "c", to: "b" }]);
		assert.equal(l.width, 3 * W + 2 * GX);
		assert.equal(l.height, 2 * H + GY);
	});
});

describe("layoutGraph with slim", () => {
	const nodes = ids("a", "b", "c", "m1", "m2");
	it("an all-sliver column is slimWidth wide and the next column starts 36 + gapX later", () => {
		const l = layoutGraph(ids("a", "b", "c"), [{ from: "b", to: "a" }, { from: "c", to: "b" }], { slim: new Set(["a"]) });
		const at = (id: string) => l.nodes.find((n) => n.id === id)!;
		assert.equal(at("a").width, 64);
		assert.equal(at("a").height, 18);
		assert.equal(at("b").x, at("a").x + 64 + GX);
		assert.equal(at("b").width, W);
		assert.equal(l.width, 64 + GX + W + GX + W);
	});
	it("sliver edge endpoints sit on the bar's middle and its right edge", () => {
		const l = layoutGraph(ids("a", "b"), [{ from: "b", to: "a" }], { slim: new Set(["a"]) });
		const a = l.nodes.find((n) => n.id === "a")!;
		const e = l.edges[0]!;
		assert.equal(e.x1, a.x + a.width);
		assert.equal(e.y1, a.y + 9);
	});
	it("a mixed column keeps the full width, with the 4px gap only next to a sliver", () => {
		const l = layoutGraph(nodes, [], { slim: new Set(["m1"]) });
		const col = ["a", "b", "c", "m1", "m2"].map((id) => l.nodes.find((n) => n.id === id)!);
		assert.equal(col.every((n) => n.width === W), true);
		const ys = col.map((n) => n.y);
		assert.equal(ys.join(","), [0, H + GY, 2 * (H + GY), 2 * (H + GY) + H + 4, 2 * (H + GY) + H + 4 + 18 + 4].join(","));
	});
});
describe("layoutGraph orderClass", () => {
	const cls = new Map([["d", 3], ["s", 4], ["t", 2], ["b", 1], ["g", 0], ["t2", 2]]);
	const list = ids("d", "s", "t", "b", "g", "t2");
	it("orders a column doing < blocked < todo < done < skipped, stable within a class", () => {
		const l = layoutGraph(list, [], { orderClass: cls });
		const byY = [...l.nodes].sort((a, b) => a.y - b.y).map((n) => n.id).join(",");
		assert.equal(byY, "g,b,t,t2,d,s");
	});
	it("is the input order without the option", () => {
		const l = layoutGraph(list, []);
		assert.equal([...l.nodes].sort((a, b) => a.y - b.y).map((n) => n.id).join(","), "d,s,t,b,g,t2");
	});
	it("edges follow the reordered nodes", () => {
		const l = layoutGraph(ids("d", "g", "x"), [{ from: "x", to: "g" }], { orderClass: new Map([["d", 3], ["g", 0]]) });
		const g = l.nodes.find((n) => n.id === "g")!;
		assert.equal(g.y, 0);
		assert.equal(l.edges[0]!.y1, g.y + g.height / 2);
	});
});
