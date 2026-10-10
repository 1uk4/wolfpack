import { describe, it, expect } from "vitest";
import { resolveShipPolicy, shouldConfirmShip } from "./ship-policy.js";
import { detectTransition } from "./stage-detection.js";
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
