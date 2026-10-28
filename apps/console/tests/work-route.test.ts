import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ROUTE_PARENT_MODE, ROUTE_ROOT, computeWorkRoute as computeRoute, cursorChoose, cursorNext, cursorPrev, startCursor, type WorkNode,
} from "../src/core/work-route.ts";

// The legacy suites below pin today's behaviour (flag off).
const computeWorkRoute = (nodes: readonly WorkNode[], target: string) =>
  computeRoute(nodes, target, { parentMode: "none" });

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
    assert.equal(r.steps[1]?.parallel, true);
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
    assert.match(r.warnings[0] ?? "", /cycle/);
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

describe("route entry via parent (entry mode)", () => {
  const on = (nodes: WorkNode[], target: string) => computeRoute(nodes, target, { parentMode: "entry" });
  const init = (id: string): WorkNode => ({ id, kind: "initiative", stage: "plan", parent: null, dependsOn: [] });
  const fi = (id: string, parent: string | null, deps: string[] = []): WorkNode =>
    ({ id, kind: "feature", stage: "in_build", parent, dependsOn: deps });
  const keys = (r: ReturnType<typeof computeRoute>) => r.edges.map((e) => `${e.from}>${e.to}${e.entry ? "*" : ""}`).sort();

  it("exit is the default mode", () => {
    assert.equal(ROUTE_PARENT_MODE, "exit");
    const ns = [init("I"), fi("F", "I"), t("a", "F")];
    assert.deepEqual(computeRoute(ns, "a"), computeRoute(ns, "a", { parentMode: "exit" }));
  });

  it("single task: Factory -> initiative -> feature -> task", () => {
    const r = on([init("I"), fi("F", "I"), t("a", "F")], "a");
    assert.deepEqual(steps(r), [["I"], ["F"], ["a"]]);
    assert.deepEqual(keys(r), ["F>a*", "I>F*", "factory>I"]);
    assert.deepEqual(r.edges[0], { from: ROUTE_ROOT, to: "I", implicit: false, root: true });
    assert.equal(r.blocked.a, false);
    assert.equal(r.firstUnfinished, 2);
  });

  it("chain within a feature enters via the feature", () => {
    const r = on([init("I"), fi("F", "I"), t("a", "F"), t("b", "F", ["a"]), t("c", "F", ["b"])], "c");
    assert.deepEqual(steps(r), [["I"], ["F"], ["a"], ["b"], ["c"]]);
    assert.deepEqual(keys(r), ["F>a*", "I>F*", "a>b", "b>c", "factory>I"]);
  });

  it("diamond still layers as parallel", () => {
    const r = on([fi("F", null), t("a", "F"), t("b", "F", ["a"]), t("c", "F", ["a"]), t("d", "F", ["b", "c"])], "d");
    assert.deepEqual(steps(r), [["F"], ["a"], ["b", "c"], ["d"]]);
    assert.deepEqual(r.parallelGroups, [["b", "c"]]);
  });

  it("feature without an initiative enters from the Factory", () => {
    const r = on([fi("F", null), t("a", "F")], "a");
    assert.deepEqual(steps(r), [["F"], ["a"]]);
    assert.deepEqual(keys(r), ["F>a*", "factory>F"]);
  });

  it("cross-feature: G terminals -> F node -> F entries (implicit)", () => {
    const nodes = [
      init("I"), fi("G", "I"), t("g1", "G"), t("g2", "G", ["g1"]), t("g3", "G", ["g1"]),
      fi("F", "I", ["G"]), t("f1", "F"), t("f2", "F", ["f1", "f0"]), t("f0", "F"),
    ];
    const r = on(nodes, "f2");
    assert.deepEqual(steps(r), [["I"], ["G"], ["g1"], ["g2", "g3"], ["F"], ["f0", "f1"], ["f2"]]);
    const implicit = r.edges.filter((e) => e.implicit).map((e) => `${e.from}>${e.to}`).sort();
    assert.deepEqual(implicit, ["F>f0", "F>f1", "g2>F", "g3>F"]);
    // F has an in-route prerequisite, so it does not also enter from its initiative.
    assert.ok(!r.edges.some((e) => e.from === "I" && e.to === "F"));
    assert.equal(r.blocked.f1, true);
  });

  it("shared ancestors appear once", () => {
    const nodes = [init("I"), fi("F", "I"), fi("H", "I"), t("a", "F"), t("b", "H"), t("c", "F", ["a", "b"])];
    const r = on(nodes, "c");
    const all = r.steps.flatMap((s) => s.nodes);
    assert.equal(new Set(all).size, all.length);
    assert.equal(r.edges.filter((e) => e.from === "I" && e.to === "F").length, 1);
    assert.deepEqual(r.steps[1]?.nodes, ["F", "H"]);
  });

  it("feature target ends at the feature after its tasks", () => {
    const nodes = [init("I"), fi("F", "I"), t("f1", "F"), t("f2", "F", ["f1"])];
    const r = on(nodes, "F");
    assert.deepEqual(steps(r), [["I"], ["f1"], ["f2"], ["F"]]);
    assert.ok(r.edges.some((e) => e.from === "f2" && e.to === "F" && !e.entry));
    assert.ok(r.edges.some((e) => e.from === "I" && e.to === "f1" && e.entry));
  });

  it("cursor starts at the first unfinished route member, not the hierarchy", () => {
    const nodes = [init("I"), fi("F", "I"), t("a", "F", [], "shipped"), t("b", "F", ["a"])];
    const r = on(nodes, "b");
    assert.deepEqual(steps(r), [["I"], ["F"], ["a"], ["b"]]);
    assert.equal(r.firstUnfinished, 3);
    assert.equal(r.blocked.b, false);
  });
});

describe("collapseDoneFeatures", () => {
  const nodes: WorkNode[] = [
    { id: "I", kind: "initiative", stage: "plan", parent: null, dependsOn: [] },
    f("S", [], "shipped"), t("s1", "S", [], "shipped"), t("s2", "S", ["s1"], "shipped"), t("s3", "S", ["s1"], "shipped"),
    f("T", ["S"], "in_build"), t("t1", "T"), t("t2", "T", ["t1"]),
  ].map((n) => (n.id === "S" || n.id === "T" ? { ...n, parent: "I" } : n));
  const opts = { collapseDoneFeatures: true, parentMode: "entry" as const };
  const ids = (r: { steps: { nodes: string[] }[] }) => r.steps.flatMap((s) => s.nodes);

  it("a shipped prerequisite feature becomes one step; edges redirect to/from it", () => {
    const full = computeRoute(nodes, "t2", { parentMode: "entry" });
    assert.ok(ids(full).includes("s2"));
    const r = computeRoute(nodes, "t2", opts);
    const all = ids(r);
    assert.ok(all.includes("S") && !all.some((id) => id.startsWith("s")));
    assert.deepEqual(r.collapsed, { S: ["s1", "s2", "s3"] });
    const keys = r.edges.map((e) => `${e.from}>${e.to}`);
    assert.ok(keys.includes("I>S") && keys.includes("S>T") && keys.includes("T>t1"));
    assert.ok(!keys.some((k) => /s[123]/.test(k)));
    assert.ok(r.steps.length < full.steps.length);
    assert.equal(r.done.S, true);
  });

  it("expanding restores its tasks to the route", () => {
    const r = computeRoute(nodes, "t2", { ...opts, expanded: new Set(["S"]) });
    assert.deepEqual(r.collapsed, {});
    assert.deepEqual(r, { ...computeRoute(nodes, "t2", { parentMode: "entry" }), collapsed: {} });
    assert.ok(ids(r).includes("s2"));
  });

  it("the target's own feature never collapses (even fully done), nor the target feature", () => {
    const done = nodes.map((n) => (n.id === "t1" || n.id === "t2" ? { ...n, stage: "shipped" } : n));
    const r = computeRoute(done, "t2", opts);
    assert.ok(ids(r).includes("t1"));
    assert.ok(!(("T") in r.collapsed));
    const rf = computeRoute(done, "T", opts);
    assert.ok(ids(rf).includes("t1") && ids(rf).includes("T"));
    assert.deepEqual(Object.keys(rf.collapsed), ["S"]);
  });

  it("a partially done feature does not collapse", () => {
    const part = nodes.map((n) => (n.id === "s3" ? { ...n, stage: "plan" } : n));
    const r = computeRoute(part, "t2", opts);
    assert.deepEqual(r.collapsed, {});
    assert.ok(ids(r).includes("s3"));
  });

  it("the cursor and stepper count steps on the collapsed route", () => {
    const r = computeRoute(nodes, "t2", opts);
    let c = startCursor(r);
    assert.equal(c.node, "T");
    assert.equal(c.step, r.firstUnfinished);
    const seen: (string | null)[] = [c.node];
    while (true) { const n = cursorNext(r, c); if (n.step === c.step) break; c = n; seen.push(c.node); }
    assert.equal(seen.length, r.steps.length - r.firstUnfinished!);
    assert.ok(!seen.some((id) => id?.startsWith("s") ?? false));
    c = cursorPrev(r, startCursor(r));
    assert.equal(c.node, "S");
  });

  it("a feature with all tasks done counts as done (ready to graduate) before it ships", () => {
    const ready = nodes.map((n) => (n.id === "S" ? { ...n, stage: "in_build" } : n));
    const r = computeRoute(ready, "t2", opts);
    assert.equal(r.done.S, true);
    assert.ok("S" in r.collapsed);
  });
});

describe("route exit via parent (exit mode)", () => {
  const ex = (nodes: WorkNode[], target: string, extra: object = {}) => computeRoute(nodes, target, { parentMode: "exit", ...extra });
  const init = (id: string): WorkNode => ({ id, kind: "initiative", stage: "plan", parent: null, dependsOn: [] });
  const fi = (id: string, parent: string | null, deps: string[] = [], stage = "in_build"): WorkNode =>
    ({ id, kind: "feature", stage, parent, dependsOn: deps });
  const keys = (r: ReturnType<typeof computeRoute>) => r.edges.map((e) => `${e.from}>${e.to}${e.exit ? "^" : ""}`).sort();

  it("single task: Factory -> task -> feature -> initiative", () => {
    const r = ex([init("I"), fi("F", "I"), t("a", "F")], "a");
    assert.deepEqual(steps(r), [["a"], ["F"], ["I"]]);
    assert.deepEqual(keys(r), ["F>I^", "a>F^", "factory>a"]);
    assert.deepEqual(r.edges[0], { from: ROUTE_ROOT, to: "a", implicit: false, root: true });
    assert.equal(r.firstUnfinished, 0);
    assert.equal(r.blocked.a, false);
    assert.equal(r.blocked.F, true);
  });

  it("chain within a feature", () => {
    const r = ex([init("I"), fi("F", "I"), t("a", "F"), t("b", "F", ["a"]), t("c", "F", ["b"])], "c");
    assert.deepEqual(steps(r), [["a"], ["b"], ["c"], ["F"], ["I"]]);
    assert.deepEqual(keys(r), ["F>I^", "a>b", "b>c", "c>F^", "factory>a"]);
  });

  it("diamond stays parallel and ends at the feature", () => {
    const r = ex([fi("F", null), t("a", "F"), t("b", "F", ["a"]), t("c", "F", ["a"]), t("d", "F", ["b", "c"])], "d");
    assert.deepEqual(steps(r), [["a"], ["b", "c"], ["d"], ["F"]]);
    assert.deepEqual(r.parallelGroups, [["b", "c"]]);
  });

  it("task target does not pull in the feature's other terminals", () => {
    const r = ex([init("I"), fi("F", "I"), t("a", "F"), t("b", "F", ["a"]), t("x", "F", ["a"])], "a");
    assert.deepEqual(steps(r), [["a"], ["F"], ["I"]]);
    const r2 = ex([init("I"), fi("F", "I"), t("a", "F"), t("b", "F", ["a"]), t("x", "F")], "b");
    assert.deepEqual(steps(r2), [["a"], ["b"], ["F"], ["I"]]);
    assert.deepEqual(keys(r2), ["F>I^", "a>b", "b>F^", "factory>a"]);
  });

  it("two features G -> F: G's tasks -> G -> F's entries -> F -> initiative", () => {
    const nodes = [
      init("I"), fi("G", "I"), t("g1", "G"), t("g2", "G", ["g1"]), t("g3", "G", ["g1"]),
      fi("F", "I", ["G"]), t("f1", "F"), t("f2", "F", ["f1", "f0"]), t("f0", "F"),
    ];
    const r = ex(nodes, "f2");
    assert.deepEqual(steps(r), [["g1"], ["g2", "g3"], ["G"], ["f0", "f1"], ["f2"], ["F"], ["I"]]);
    assert.deepEqual(keys(r), ["F>I^", "G>f0", "G>f1", "f0>f2", "f1>f2", "f2>F^", "factory>g1", "g1>g2", "g1>g3", "g2>G^", "g3>G^"].sort());
    assert.ok(!r.edges.some((e) => e.from === "G" && e.to === "I"), "G leads into F, not straight to the initiative");
    assert.deepEqual(r.edges.filter((e) => e.implicit).map((e) => `${e.from}>${e.to}`).sort(), ["G>f0", "G>f1"]);
    assert.equal(r.blocked.f1, true);
  });

  it("feature target: its tasks, prerequisite features, then the feature and initiative", () => {
    const nodes = [init("I"), fi("G", "I"), t("g", "G"), fi("F", "I", ["G"]), t("f1", "F"), t("f2", "F", ["f1"]), t("z", "F")];
    const r = ex(nodes, "F");
    assert.deepEqual(steps(r), [["g"], ["G"], ["f1", "z"], ["f2"], ["F"], ["I"]]);
    assert.ok(r.edges.some((e) => e.from === "f2" && e.to === "F" && e.exit));
    assert.ok(r.edges.some((e) => e.from === "z" && e.to === "F" && e.exit));
  });

  it("initiative target: every feature path leads to it", () => {
    const nodes = [init("I"), fi("G", "I"), t("g", "G"), fi("F", "I", ["G"]), t("f", "F"), fi("H", "I"), t("h", "H"), t("other", null)];
    const r = ex(nodes, "I");
    assert.deepEqual(steps(r), [["g", "h"], ["G", "H"], ["f"], ["F"], ["I"]]);
    const all = r.steps.flatMap((s) => s.nodes).sort();
    assert.deepEqual(all, ["F", "G", "H", "I", "f", "g", "h"]);
    assert.equal(r.steps.at(-1)!.nodes.join(), "I");
    assert.deepEqual(keys(r).filter((k) => k.endsWith(">I^")), ["F>I^", "H>I^"]);
  });

  it("feature without an initiative ends at itself", () => {
    const r = ex([fi("F", null), t("a", "F")], "a");
    assert.deepEqual(steps(r), [["a"], ["F"]]);
    assert.deepEqual(keys(r), ["a>F^", "factory>a"]);
  });

  it("a feature with no tasks enters from the Factory", () => {
    const r = ex([init("I"), fi("F", "I")], "F");
    assert.deepEqual(steps(r), [["F"], ["I"]]);
    assert.deepEqual(keys(r), ["F>I^", "factory>F"]);
  });

  it("collapse: one node with the prerequisite paths in and dependents/initiative out", () => {
    const nodes = [
      init("I"), fi("S", "I", [], "shipped"), t("s1", "S", [], "shipped"), t("s2", "S", ["s1"], "shipped"),
      fi("T", "I", ["S"]), t("t1", "T"), t("t2", "T", ["t1"]),
    ];
    const full = ex(nodes, "t2");
    assert.deepEqual(steps(full), [["s1"], ["s2"], ["S"], ["t1"], ["t2"], ["T"], ["I"]]);
    const r = ex(nodes, "t2", { collapseDoneFeatures: true });
    assert.deepEqual(r.collapsed, { S: ["s1", "s2"] });
    assert.deepEqual(steps(r), [["S"], ["t1"], ["t2"], ["T"], ["I"]]);
    assert.deepEqual(keys(r), ["S>t1", "T>I^", "factory>S", "t1>t2", "t2>T^"]);
    assert.equal(r.done.S, true);
    // A collapsed feature with no dependents leads to the initiative.
    const solo = ex([init("I"), fi("S", "I", [], "shipped"), t("s1", "S", [], "shipped"), t("x", null)], "I", { collapseDoneFeatures: true });
    assert.deepEqual(keys(solo), ["S>I^", "factory>S"]);
  });

  it("cursor starts at the first unfinished task, skipping containers", () => {
    const nodes = [init("I"), fi("G", "I", [], "shipped"), t("g", "G", [], "shipped"), fi("F", "I", ["G"]), t("a", "F"), t("b", "F", ["a"])];
    const r = ex(nodes, "b");
    assert.deepEqual(steps(r), [["g"], ["G"], ["a"], ["b"], ["F"], ["I"]]);
    assert.equal(r.firstUnfinished, 2);
    assert.deepEqual(startCursor(r), { step: 2, node: "a" });
    const done = ex([init("I"), fi("F", "I"), t("a", "F", [], "shipped")], "a");
    assert.equal(done.firstUnfinished, null);
  });

  it("collapse cursor lands on the collapsed done feature when stepping back", () => {
    const nodes = [init("I"), fi("S", "I", [], "shipped"), t("s1", "S", [], "shipped"), fi("T", "I", ["S"]), t("t1", "T")];
    const r = ex(nodes, "t1", { collapseDoneFeatures: true });
    assert.deepEqual(startCursor(r), { step: 1, node: "t1" });
    assert.equal(cursorPrev(r, startCursor(r)).node, "S");
  });
});
