import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutTaskGraph, taskComponents, taskNodeHeight, type TaskNode, type TaskStatus } from "../src/core/index.ts";

const n = (id: string, status: TaskStatus = "ready", title = `T ${id}`): TaskNode => ({ id, title, kind: "task", stage: "", status });
const opts = { nodeWidth: 200, maxWidth: 650, gapX: 20, gapY: 40 };
const at = (l: ReturnType<typeof layoutTaskGraph>, id: string) => l.nodes.find((p) => p.id === id)!;

describe("layoutTaskGraph", () => {
	it("stacks chains top-to-bottom by dependency and puts singles after them", () => {
		const nodes = [n("s1"), n("a", "shipped"), n("b", "building"), n("c", "blocked"), n("s2")];
		const l = layoutTaskGraph(nodes, [{ from: "a", to: "b" }, { from: "b", to: "c" }], opts);
		assert.ok(at(l, "a").y < at(l, "b").y && at(l, "b").y < at(l, "c").y);
		assert.ok(at(l, "s1").y > at(l, "c").y);
		assert.equal(at(l, "s1").y, at(l, "s2").y);
	});
	it("wraps singles into columns that fit the width, in status-then-id order", () => {
		const nodes = ["e", "d", "c", "b", "a"].map((id) => n(id, id === "c" ? "building" : id === "a" ? "shipped" : "ready"));
		const l = layoutTaskGraph(nodes, [], opts); // 650 fits 3 columns of 200 + 20 gaps
		const order = [...l.nodes].sort((p, q) => p.y - q.y || p.x - q.x).map((p) => p.id);
		assert.deepEqual(order, ["c", "b", "d", "e", "a"]);
		assert.deepEqual([...new Set(l.nodes.map((p) => p.x))].sort((p, q) => p - q), [0, 220, 440]);
		assert.equal(new Set(l.nodes.map((p) => p.y)).size, 2);
		assert.equal(l.width, 640);
	});
	it("one column when the width is narrow", () => {
		const l = layoutTaskGraph([n("a"), n("b"), n("c")], [], { ...opts, maxWidth: 250 });
		assert.deepEqual(new Set(l.nodes.map((p) => p.x)), new Set([0]));
		assert.equal(new Set(l.nodes.map((p) => p.y)).size, 3);
	});
	it("orders larger chains first and is deterministic regardless of input order", () => {
		const nodes = [n("p"), n("q"), n("x"), n("y"), n("z")];
		const edges = [{ from: "p", to: "q" }, { from: "x", to: "y" }, { from: "y", to: "z" }];
		const l1 = layoutTaskGraph(nodes, edges, opts);
		const l2 = layoutTaskGraph([...nodes].reverse(), [...edges].reverse(), opts);
		assert.ok(at(l1, "x").y < at(l1, "p").y);
		const key = (l: typeof l1) => JSON.stringify([...l.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)));
		assert.equal(key(l1), key(l2));
	});
	it("separate chains do not overlap; empty graph is empty", () => {
		const l = layoutTaskGraph([n("a"), n("b"), n("c"), n("d")], [{ from: "a", to: "b" }, { from: "c", to: "d" }], opts);
		assert.ok(at(l, "c").y >= at(l, "b").y + at(l, "b").h);
		assert.deepEqual(layoutTaskGraph([], [], opts), { nodes: [], width: 0, height: 0 });
	});
	it("components: chains vs singles", () => {
		const c = taskComponents([n("a"), n("b"), n("s")], [{ from: "a", to: "b" }]);
		assert.deepEqual(c.chains.map((g) => g.map((x) => x.id)), [["a", "b"]]);
		assert.deepEqual(c.singles.map((x) => x.id), ["s"]);
	});
	it("node height grows with the title up to 3 lines", () => {
		const one = taskNodeHeight("Short", 220);
		const three = taskNodeHeight("word ".repeat(60), 220);
		assert.ok(three > one);
		assert.equal(three, taskNodeHeight("word ".repeat(200), 220));
	});
});
