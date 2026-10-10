import { describe, it, expect } from "vitest";
import type { WorkItem } from "@wolfpack/kb/client";
import { initialState, reduce, leftRows, rightRows, rightTree, dependencyTree, relatedTo, firstTask, progress, type SelectorState } from "./selector.js";

let n = 0;
const w = (kind: string, stage: string, partOf: string | null = null, extra: Partial<WorkItem> = {}) =>
  ({ id: `work-wp-${String(++n).padStart(7, "0")}`, kind, stage, partOf, title: `${kind}${n}`, dependsOn: [], container: false, ...extra }) as unknown as WorkItem;

// Fixture: Inbox, initiative (in_build) > feature A (in_build: t1 shipped, t2 open, t3 open) + feature B (plan: t4),
// standalone feature C (plan), idea.
const inbox = w("feature", "in_build", null, { container: true, title: "Inbox" });
const init = w("initiative", "in_build");
const fa = w("feature", "in_build", init.id);
const fb = w("feature", "plan", init.id);
const t1 = w("task", "shipped", fa.id);
const t2 = w("task", "plan", fa.id);
const t3 = w("task", "in_build", fa.id);
const t4 = w("task", "plan", fb.id);
const fc = w("feature", "plan");
const idea = w("idea", "idea");
const all = [inbox, init, fa, fb, t1, t2, t3, t4, fc, idea];

const press = (s: SelectorState, keys: string[], bound: string | null = null) => {
  let effect;
  for (const k of keys) ({ state: s, effect } = reduce(s, k as any, all, bound));
  return { s, effect };
};

describe("selector rows", () => {
  it("left: Inbox, initiatives collapsed, standalone features and ideas", () => {
    expect(leftRows(all, []).map((r) => r.item.id)).toEqual([inbox.id, init.id, fc.id, idea.id]);
    expect(leftRows(all, [init.id]).map((r) => [r.item.id, r.depth])).toEqual([
      [inbox.id, 0], [init.id, 0], [fa.id, 1], [fb.id, 1], [fc.id, 0], [idea.id, 0],
    ]);
  });

  it("right: open tasks first (in_build before plan), shipped last", () => {
    expect(rightRows(all, fa.id).map((t) => t.id)).toEqual([t3.id, t2.id, t1.id]);
  });

  it("first task skips shipped and blocked; falls back to first open", () => {
    const blocked = { ...t3, dependsOn: [t2.id] } as WorkItem;
    expect(firstTask([blocked, t2], [...all, blocked])?.id).toBe(t2.id);
    expect(firstTask([{ ...t2, dependsOn: [t4.id] } as WorkItem], all)?.id).toBe(t2.id);
  });

  it("progress counts work units; initiatives roll up their features", () => {
    expect(progress(fa, all)).toEqual({ done: 1, total: 3 });
    expect(progress(init, all)).toEqual({ done: 1, total: 4 });
  });
});

describe("selector keys", () => {
  const start = initialState(all, null);

  it("starts collapsed on the left with nothing bound", () => {
    expect(start).toEqual({ pane: "left", leftIdx: 0, rightIdx: 0, expanded: [], openId: null });
  });

  it("l expands an initiative, h collapses it back onto the initiative", () => {
    let { s } = press(start, ["down", "right"]);
    expect(s.expanded).toEqual([init.id]);
    ({ s } = press(s, ["down", "down", "left"])); // on feature B → collapse parent
    expect(s.expanded).toEqual([]);
    expect(leftRows(all, s.expanded)[s.leftIdx].item.id).toBe(init.id);
  });

  it("opening an in_build feature with nothing bound auto-binds its first task", () => {
    const { s, effect } = press(start, ["down", "right", "down", "enter"]);
    expect(s).toMatchObject({ pane: "right", openId: fa.id });
    expect(effect).toEqual({ type: "bind", id: t3.id });
    expect(rightRows(all, s.openId)[s.rightIdx].id).toBe(t3.id);
  });

  it("opening a plan feature, or any feature while something is bound, binds nothing", () => {
    expect(press(start, ["down", "right", "down", "down", "enter"]).effect).toBeUndefined(); // feature B is plan
    const { s, effect } = press(start, ["down", "right", "down", "enter"], t4.id); // t4 bound elsewhere
    expect(effect).toBeUndefined();
    expect(s.openId).toBe(fa.id);
  });

  it("j/k move focus without binding; Space binds, Space again unbinds", () => {
    const opened = press(start, ["down", "right", "down", "enter"]).s;
    const moved = press(opened, ["down"], t3.id);
    expect(moved.effect).toBeUndefined();
    expect(press(moved.s, ["space"], t3.id).effect).toEqual({ type: "bind", id: t2.id });
    expect(press(opened, ["space"], t3.id).effect).toEqual({ type: "unbind" });
  });

  it("shipped tasks and workspaces are never bound; h returns left", () => {
    const opened = press(start, ["down", "right", "down", "enter"], t2.id).s;
    expect(press(opened, ["down", "down", "space"], t2.id).effect).toBeUndefined(); // t1 shipped
    expect(press(start, ["space"]).effect).toBeUndefined();
    expect(press(opened, ["left"], t2.id).s.pane).toBe("left");
  });

  it("reopens on the bound task's feature", () => {
    const s = initialState(all, t2.id);
    expect(s).toMatchObject({ pane: "right", openId: fa.id, expanded: [init.id] });
    expect(rightRows(all, s.openId)[s.rightIdx].id).toBe(t2.id);
  });
});

describe("dependency tree", () => {
  const f = w("feature", "in_build");
  const a = w("task", "plan", f.id);
  const b = w("task", "plan", f.id, { dependsOn: [] });
  const c = w("task", "plan", f.id);
  const d = w("task", "shipped", f.id);
  // c waits on a and b; b waits on a  →  a, └▸ b, └▸ └▸ c (+1), then shipped d
  (b as any).dependsOn = [a.id];
  (c as any).dependsOn = [b.id, a.id];
  const set = [f, c, b, a, d];

  it("nests each task under its first in-list prerequisite, shipped last", () => {
    expect(rightTree(set, f.id).map((r) => [r.item.id, r.chain, r.extra])).toEqual([
      [a.id, 0, 0], [b.id, 1, 0], [c.id, 2, 1], [d.id, 0, 0],
    ]);
    expect(rightRows(set, f.id).map((t) => t.id)).toEqual([a.id, b.id, c.id, d.id]);
  });

  it("first task is the unblocked prerequisite", () => {
    expect(firstTask(rightRows(set, f.id), set)?.id).toBe(a.id);
  });

  it("orders an initiative's features by dependency in the left pane", () => {
    const i = w("initiative", "plan");
    const f1 = w("feature", "plan", i.id);
    const f2 = w("feature", "plan", i.id, { dependsOn: [f1.id] });
    const rows = leftRows([i, f2, f1], [i.id]);
    expect(rows.map((r) => [r.item.id, r.depth, r.chain])).toEqual([[i.id, 0, 0], [f1.id, 1, 0], [f2.id, 1, 1]]);
  });

  it("survives a cycle in bad data", () => {
    const x = w("task", "plan", f.id);
    const y = w("task", "plan", f.id, { dependsOn: [x.id] });
    (x as any).dependsOn = [y.id];
    expect(dependencyTree([x, y]).map((r) => r.item.id).sort()).toEqual([x.id, y.id].sort());
  });

  it("relatedTo marks prerequisites and dependents of the focused item", () => {
    expect([...relatedTo(b, set).prereqs]).toEqual([a.id]);
    expect([...relatedTo(b, set).dependents]).toEqual([c.id]);
  });
});
