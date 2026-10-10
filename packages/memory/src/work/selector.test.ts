import { describe, it, expect } from "vitest";
import type { WorkItem } from "@wolfpack/kb/client";
import { initialState, reduce, leftRows, rightRows, firstTask, progress, type SelectorState } from "./selector.js";

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
