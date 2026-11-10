import { describe, expect, it } from "vitest";
import { WorkItemResponseSchema } from "./index.js";

const item = { id: "t1", title: "T", kind: "task", stage: "plan", domain: "wolfpack" };

describe("WorkItemResponseSchema", () => {
  it("keeps the reassigned list a move reports, and parses without it", () => {
    const withIt = WorkItemResponseSchema.parse({ item, reassigned: [{ id: "t1", from: null, to: "luka" }] });
    expect(withIt.reassigned).toEqual([{ id: "t1", from: null, to: "luka" }]);
    expect(WorkItemResponseSchema.parse({ item }).reassigned).toBeUndefined();
  });
});
