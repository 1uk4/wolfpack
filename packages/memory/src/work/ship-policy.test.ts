import { describe, it, expect } from "vitest";
import { resolveShipPolicy, shouldConfirmShip } from "./ship-policy.js";
import { detectTransition } from "./stage-detection.js";
import { parentReadyToShip } from "./graduate.js";
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

  it("still offers to ship a feature once every child task is complete", () => {
    const feature = { kind: "feature", stage: "in_build", title: "f" } as WorkItem;
    expect(detectTransition(feature, ctx({ childCount: 2, completedChildCount: 2 }))?.to).toBe("shipped");
    expect(detectTransition(feature, ctx({ childCount: 2, completedChildCount: 1 }))).toBeNull();
  });
});

describe("parentReadyToShip", () => {
  const item = (kind: string, stage: string) => ({ kind, stage, title: kind }) as WorkItem;
  const done = item("task", "shipped");
  const open = item("task", "in_build");

  it("is ready when the last child of an unshipped feature/initiative ships", () => {
    expect(parentReadyToShip(item("feature", "in_build"), [done, done])).toBe(true);
    expect(parentReadyToShip(item("initiative", "plan"), [done])).toBe(true);
  });

  it("is not ready while a child is open, or when there is nothing to ship", () => {
    expect(parentReadyToShip(item("feature", "in_build"), [done, open])).toBe(false);
    expect(parentReadyToShip(item("feature", "in_build"), [])).toBe(false);
    expect(parentReadyToShip(item("feature", "shipped"), [done])).toBe(false); // already shipped
    expect(parentReadyToShip(item("task", "in_build"), [done])).toBe(false); // tasks don't graduate
    expect(parentReadyToShip(undefined, [done])).toBe(false); // no parent
  });
});
