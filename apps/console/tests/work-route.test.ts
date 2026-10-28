import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ROUTE_ROOT, computeWorkRoute, cursorChoose, cursorNext, cursorPrev, startCursor, type WorkNode,
} from "../src/core/work-route.ts";

const t = (id: string, parent: string | null, deps: string[] = [], stage = "plan"): WorkNode =>
  ({ id, kind: "task", stage, parent, dependsOn: deps });
const f = (id: string, deps: string[] = [], stage = "in_build"): WorkNode =>
  ({ id, kind: "feature", stage, parent: null, dependsOn: deps });
const steps = (r: ReturnType<typeof computeWorkRoute>) => r.steps.map((s) => s.nodes);

describe("work route", () => {
  it("chain", () => {
    const r = computeWorkRoute([f("F"), t("a", "F"), t("b", "F", ["a"]), t("c", "F", ["b"])], "c");
    assert.deepEqual(steps(r), [["a"], ["b"], ["c"]]);
    assert.deepEqual(r.parallelGroups, []);
    assert.deepEqual(r.edges[0], { from: ROUTE_ROOT, to: "a", implicit: false, root: true });
    assert.equal(r.blocked.a, false);
    assert.equal(r.blocked.b, true);
    assert.equal(r.firstUnfinished, 0);
  });

  it("only ancestors of the target", () => {
    const r = computeWorkRoute([f("F"), t("a", "F"), t("b", "F", ["a"]), t("x", "F")], "b");
    assert.deepEqual(steps(r), [["a"], ["b"]]);
  });

  it("diamond", () => {
    const r = computeWorkRoute([f("F"), t("a", "F"), t("b", "F", ["a"]), t("c", "F", ["a"]), t("d", "F", ["b", "c"])], "d");
    assert.deepEqual(steps(r), [["a"], ["b", "c"], ["d"]]);
    assert.deepEqual(r.parallelGroups, [["b", "c"]]);
    assert.equal(r.steps[1].parallel, true);
  });

  it("uneven diamond uses longest path", () => {
    const r = computeWorkRoute([f("F"), t("a", "F"), t("b", "F", ["a"]), t("c", "F", ["b"]), t("d", "F", ["a", "c"])], "d");
    assert.deepEqual(steps(r), [["a"], ["b"], ["c"], ["d"]]);
  });

  it("wide fan-out / fan-in", () => {
    const mids = ["m1", "m2", "m3", "m4", "m5"];
    const r = computeWorkRoute(
      [f("F"), t("s", "F"), ...mids.map((m) => t(m, "F", ["s"])), t("e", "F", mids)], "e");
    assert.deepEqual(steps(r), [["s"], mids, ["e"]]);
    assert.equal(r.parallelGroups.length, 1);
  });

  it("cross-feature dependency walks through tasks with two terminals", () => {
    const nodes = [
      f("G"), t("g1", "G"), t("g2", "G", ["g1"]), t("g3", "G", ["g1"]),
      f("F", ["G"]), t("f1", "F"), t("f2", "F", ["f1", "f0"]), t("f0", "F"),
    ];
    const r = computeWorkRoute(nodes, "f2");
    assert.deepEqual(steps(r), [["g1"], ["g2", "g3"], ["f0", "f1"], ["f2"]]);
    const implicit = r.edges.filter((e) => e.implicit).map((e) => `${e.from}>${e.to}`).sort();
    assert.deepEqual(implicit, ["g2>f0", "g2>f1", "g3>f0", "g3>f1"]);
    assert.equal(r.blocked.f1, true);
  });

  it("feature target ends at the feature after all its tasks", () => {
    const nodes = [f("G"), t("g1", "G"), f("F", ["G"]), t("f1", "F"), t("f2", "F"), t("f3", "F", ["f1"])];
    const r = computeWorkRoute(nodes, "F");
    assert.deepEqual(steps(r), [["g1"], ["f1", "f2"], ["f3"], ["F"]]);
    assert.equal(r.steps.at(-1)!.nodes[0], "F");
    assert.ok(r.edges.some((e) => e.from === "f3" && e.to === "F"));
    assert.ok(r.edges.some((e) => e.from === "f2" && e.to === "F"));
  });

  it("shipped prerequisites are done; cursor starts at first unfinished step", () => {
    const r = computeWorkRoute(
      [f("F"), t("a", "F", [], "shipped"), t("b", "F", ["a"], "archived"), t("c", "F", ["b"], "in_build"), t("d", "F", ["c"])], "d");
    assert.deepEqual([r.done.a, r.done.b, r.done.c], [true, true, false]);
    assert.equal(r.blocked.c, false);
    assert.equal(r.blocked.d, true);
    assert.equal(r.firstUnfinished, 2);
    assert.deepEqual(startCursor(r), { step: 2, node: "c" });
  });

  it("all done starts at the last step", () => {
    const r = computeWorkRoute([f("F"), t("a", "F", [], "shipped"), t("b", "F", ["a"], "shipped")], "b");
    assert.equal(r.firstUnfinished, null);
    assert.equal(startCursor(r).step, 1);
  });

  it("cycle is broken deterministically with a warning", () => {
    const nodes = [f("F"), t("a", "F", ["c"]), t("b", "F", ["a"]), t("c", "F", ["b"])];
    const r = computeWorkRoute(nodes, "c");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /cycle/);
    assert.equal(r.steps.flatMap((s) => s.nodes).length, 3);
    assert.deepEqual(computeWorkRoute(nodes, "c"), r);
  });

  it("feature with no tasks stands in as one node", () => {
    const nodes = [f("G"), f("F", ["G"]), t("f1", "F")];
    const r = computeWorkRoute(nodes, "f1");
    assert.deepEqual(steps(r), [["G"], ["f1"]]);
    assert.equal(computeWorkRoute(nodes, "G").steps.length, 1);
  });

  it("unknown target yields an empty route", () => {
    assert.deepEqual(computeWorkRoute([], "nope").steps, []);
  });
});

describe("route cursor", () => {
  const nodes = [f("F"), t("a", "F"), t("b", "F", ["a"]), t("c", "F", ["a"]), t("d", "F", ["b", "c"])];
  const r = computeWorkRoute(nodes, "d");

  it("steps and clamps at both ends", () => {
    let c = startCursor(r);
    assert.deepEqual(c, { step: 0, node: "a" });
    assert.deepEqual(cursorPrev(r, c), c);
    c = cursorNext(r, c);
    assert.equal(c.step, 1);
    c = cursorNext(r, cursorNext(r, c));
    assert.deepEqual(c, { step: 2, node: "d" });
    assert.deepEqual(cursorPrev(r, cursorPrev(r, cursorPrev(r, c))), { step: 0, node: "a" });
  });

  it("chooses within a parallel step", () => {
    let c = cursorNext(r, startCursor(r));
    assert.equal(c.node, "b");
    c = cursorChoose(r, c, "c");
    assert.deepEqual(c, { step: 1, node: "c" });
    assert.deepEqual(cursorChoose(r, c, "d"), c);
  });
});
