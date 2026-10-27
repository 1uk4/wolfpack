import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTaskGraph, featureIdFor, type WorkRecordResponse } from "../src/core/index.ts";

type Child = NonNullable<WorkRecordResponse["children"]>[number];
const child = (id: string, stage: string, dependsOn: string[] = [], kind = "task"): Child => ({ id, title: `T-${id}`, kind, stage, dependsOn });
const rec = (o: Partial<WorkRecordResponse> & { id: string }): WorkRecordResponse => ({ title: o.id, kind: "task", stage: "idea", plan: "", record: "", ...o });
const feature = (children: Child[], o: Partial<WorkRecordResponse> = {}) => rec({ id: "F", kind: "feature", title: "Feat", stage: "in_build", children, ...o });
const task = (id = "b") => rec({ id, kind: "task", partOf: "F" });
const graph = (b: WorkRecordResponse, f: WorkRecordResponse) => {
	const g = buildTaskGraph(b, f);
	assert.equal(g.kind, "graph");
	return g as Extract<typeof g, { kind: "graph" }>;
};
const statuses = (g: ReturnType<typeof graph>) => Object.fromEntries(g.nodes.map((n) => [n.id, n.status]));

describe("buildTaskGraph", () => {
	it("derives shipped / building / ready / blocked from stage and dependencies", () => {
		const g = graph(task("b"), feature([
			child("a", "shipped"),
			child("l", "live"),
			child("b", "in_build", ["a"]),
			child("c", "approved", ["a", "l"]), // all deps shipped -> ready
			child("d", "plan", ["b"]), // dep building -> blocked
			child("e", "idea", ["a", "d"]), // one dep unshipped -> blocked
			child("f", "idea"), // no deps -> ready
		]));
		assert.deepEqual(statuses(g), { a: "shipped", l: "shipped", b: "building", c: "ready", d: "blocked", e: "blocked", f: "ready" });
	});

	it("edges run dependency -> dependent; a dependency not in the feature draws no edge and blocks", () => {
		const g = graph(task("b"), feature([child("a", "shipped"), child("b", "idea", ["a"]), child("c", "idea", ["b", "a"]), child("d", "idea", ["OUTSIDE"])]));
		assert.deepEqual(g.edges, [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }]);
		assert.equal(statuses(g).d, "blocked");
		assert.equal(statuses(g).b, "ready");
	});

	it("progress counts shipped over visible nodes", () => {
		const g = graph(task("b"), feature([child("a", "shipped"), child("b", "live"), child("c", "idea")]));
		assert.deepEqual(g.progress, { shipped: 2, total: 3 });
		assert.equal(g.label, "2/3 shipped");
	});

	it("archived children are hidden (no node, edge, progress) unless the feature is archived; a dep on one is satisfied", () => {
		const kids = [child("a", "archived"), child("b", "idea", ["a"]), child("c", "shipped")];
		const hidden = graph(task("b"), feature(kids));
		assert.deepEqual(hidden.nodes.map((n) => n.id), ["b", "c"]);
		assert.deepEqual(hidden.edges, []);
		assert.equal(hidden.nodes[0]?.status, "ready");
		assert.equal(hidden.label, "1/2 shipped");
		const shown = graph(task("b"), feature(kids, { stage: "archived" }));
		assert.equal(shown.nodes.length, 3);
		assert.equal(statuses(shown).a, "archived");
		assert.equal(statuses(shown).b, "ready");
		assert.deepEqual(shown.edges, [{ from: "a", to: "b" }]);
	});

	it("a bound task glows; a bound feature shows its own children without a glow", () => {
		const f = feature([child("a", "idea"), child("b", "idea")]);
		assert.equal(graph(task("b"), f).boundId, "b");
		assert.equal(graph(f, f).boundId, null);
		assert.equal(graph(task("zz"), f).boundId, null); // bound item not among the children
	});

	it("which feature: a feature is its own, anything else its parent", () => {
		assert.equal(featureIdFor(rec({ id: "F", kind: "feature" })), "F");
		assert.equal(featureIdFor(rec({ id: "t", kind: "task", partOf: "F" })), "F");
		assert.equal(featureIdFor(rec({ id: "t", kind: "issue", partOf: null })), null);
		assert.equal(featureIdFor(rec({ id: "t", kind: "spike" })), null);
	});

	it("an Inbox parent (container flag only) gives a count, not a graph; the title alone does not", () => {
		const kids = [child("a", "idea"), child("b", "idea")];
		assert.deepEqual(buildTaskGraph(task("a"), feature([], { container: true, title: "Inbox", childCount: 205 })), { kind: "inbox", featureId: "F", title: "Inbox", count: 205 });
		assert.deepEqual(buildTaskGraph(task("a"), feature([], { container: true, children: undefined })), { kind: "inbox", featureId: "F", title: "Feat", count: null });
		assert.equal(buildTaskGraph(task("a"), feature(kids, { title: "Inbox" })).kind, "graph");
	});

	it("nothing to graph without a bound item, a feature record, or listed children", () => {
		assert.deepEqual(buildTaskGraph(null, feature([])), { kind: "none" });
		assert.deepEqual(buildTaskGraph(task(), null), { kind: "none" });
		assert.deepEqual(buildTaskGraph(task(), rec({ id: "F", kind: "feature" })), { kind: "none" });
	});

	it("is deterministic: same input, same output, input order kept", () => {
		const f = feature([child("z", "idea"), child("a", "shipped", []), child("m", "idea", ["a"])]);
		assert.deepEqual(buildTaskGraph(task("m"), f), buildTaskGraph(task("m"), f));
		assert.deepEqual(graph(task("m"), f).nodes.map((n) => n.id), ["z", "a", "m"]);
	});
});
