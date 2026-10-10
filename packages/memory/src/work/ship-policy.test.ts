import { describe, it, expect } from "vitest";
import { resolveShipPolicy, shouldConfirmShip } from "./ship-policy.js";
import { detectTransition } from "./stage-detection.js";
import { readyToGraduate } from "./graduate.js";
import type { WorkItem } from "@wolfpack/kb/client";

describe("ship policy", () => {
  it("defaults to confirm; WOLFPACK_TASK_SHIP=auto opts a wolf into auto", () => {
    expect(resolveShipPolicy({})).toBe("confirm");
    expect(resolveShipPolicy({ WOLFPACK_TASK_SHIP: " AUTO " })).toBe("auto");
    expect(resolveShipPolicy({ WOLFPACK_TASK_SHIP: "yes" })).toBe("confirm");
  });

  it("asks only when the policy wants it and someone can answer", () => {
    expect(shouldConfirmShip("confirm", true)).toBe(true);
    expect(shouldConfirmShip("confirm", false)).toBe(false); // headless loop never blocks
    expect(shouldConfirmShip("auto", true)).toBe(false);
  });
});

describe("detectTransition (in_build)", () => {
  const ctx = (over: Partial<Parameters<typeof detectTransition>[1]> = {}) => ({
    bodyLength: 1000,
    hasSuccessCriteria: true,
    childCount: 0,
    completedChildCount: 0,
    hasOpenQuestions: false,
    recentActivity: ["done: implemented and complete"],
    ...over,
  });

  it("no longer guesses a task is done from note keywords (task_done asks instead)", () => {
    const task = { kind: "task", stage: "in_build", title: "t" } as WorkItem;
    expect(detectTransition(task, ctx())).toBeNull();
  });

  it("never offers to ship a feature or initiative (graduation is g in /task)", () => {
    const feature = { kind: "feature", stage: "in_build", title: "f" } as WorkItem;
    expect(detectTransition(feature, ctx({ childCount: 2, completedChildCount: 2 }))).toBeNull();
  });

});

describe("readyToGraduate", () => {
  let n = 0;
  const w = (kind: string, stage: string, partOf?: string, extra: Partial<WorkItem> = {}) =>
    ({ id: `w${++n}`, kind, stage, partOf: partOf ?? null, title: `${kind}${n}`, graduated: null, container: false, ...extra }) as unknown as WorkItem;

  it("a feature is ready once all its tasks are done, whatever its own stage", () => {
    const f = w("feature", "in_build");
    const [a, b] = [w("task", "shipped", f.id), w("task", "plan", f.id)];
    expect(readyToGraduate(f, [f, a, b])).toBe(false);
    expect(readyToGraduate(f, [f, a, { ...b, stage: "shipped" } as WorkItem])).toBe(true);
    expect(readyToGraduate(w("feature", "in_build"), [])).toBe(false); // no tasks
  });

  it("graduated features, the Inbox and tasks are never ready", () => {
    const f = w("feature", "shipped", undefined, { graduated: "2026-10-10" } as any);
    const inbox = w("feature", "in_build", undefined, { container: true });
    const t = w("task", "shipped", f.id);
    expect(readyToGraduate(f, [f, t])).toBe(false);
    expect(readyToGraduate(inbox, [inbox, w("task", "shipped", inbox.id)])).toBe(false);
    expect(readyToGraduate(t, [t])).toBe(false);
  });

  it("an initiative is ready only when all its current features graduated", () => {
    const i = w("initiative", "in_build");
    const done = w("feature", "shipped", i.id, { graduated: "2026-10-10" } as any);
    const last = w("feature", "in_build", i.id);
    expect(readyToGraduate(i, [i, done, last])).toBe(false);
    expect(readyToGraduate(i, [i, done, { ...last, graduated: "2026-10-10" } as any])).toBe(true);
  });
});
