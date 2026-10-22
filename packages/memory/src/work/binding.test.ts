import { describe, it, expect } from "vitest";
import {
  UNBOUND_CONTEXT,
  BINDING_RULES,
  shouldBindOnCreate,
  notBoundReason,
  bindingLabel,
  headsUp,
  withHeadsUp,
  recordFeatureId,
} from "./binding.js";

const base = { kind: "task", assignee: "1uk4", wolf: "1uk4", bound: false };

describe("shouldBindOnCreate", () => {
  it("binds a task/issue/spike assigned to this wolf when nothing is bound", () => {
    for (const kind of ["task", "issue", "spike"]) expect(shouldBindOnCreate({ ...base, kind })).toBe(true);
  });
  it("does not bind when something is bound, when assigned elsewhere, or for workspaces", () => {
    expect(shouldBindOnCreate({ ...base, bound: true })).toBe(false);
    expect(shouldBindOnCreate({ ...base, assignee: "hal" })).toBe(false);
    for (const kind of ["feature", "initiative", "idea"]) expect(shouldBindOnCreate({ ...base, kind })).toBe(false);
  });
  it("an explicit bind wins for bindable items, never for workspaces", () => {
    expect(shouldBindOnCreate({ ...base, bound: true, bind: true })).toBe(true);
    expect(shouldBindOnCreate({ ...base, bind: false })).toBe(false);
    expect(shouldBindOnCreate({ ...base, kind: "feature", bind: true })).toBe(false);
  });
  it("says why it did not bind", () => {
    expect(notBoundReason({ ...base, bound: true })).toContain("already bound");
    expect(notBoundReason({ ...base, assignee: "hal" })).toContain("hal");
    expect(notBoundReason({ ...base, kind: "feature" })).toContain("workspaces");
    expect(notBoundReason({ ...base, bind: false })).toContain("bind was false");
  });
});

describe("headsUp", () => {
  it("is empty for the bound item", () => {
    expect(headsUp({ id: "a", title: "A" }, { id: "a", title: "A" })).toBe("");
    expect(withHeadsUp("done", { id: "a" }, { id: "a" })).toBe("done");
  });
  it("names both items, or nothing, and the task_bind call", () => {
    expect(headsUp({ id: "w-1", title: "Fix" }, { id: "w-2", title: "Other" })).toBe(
      `Heads-up: you're working on "Fix" (w-1) but the bound item is "Other" (w-2). Call task_bind w-1 if you're switching.`,
    );
    expect(headsUp({ id: "w-1", title: "Fix" }, null)).toBe(
      `Heads-up: you're working on "Fix" (w-1) but the bound item is nothing. Call task_bind w-1 if you're switching.`,
    );
    expect(withHeadsUp("Logged.", { id: "w-1" }, null).split("\n")).toHaveLength(2);
  });
});

describe("texts", () => {
  it("unbound context says where learning goes and how to fix it", () => {
    expect(UNBOUND_CONTEXT).toBe(
      "No work item bound: what you learn now goes to den topics, not to a work item. Bind the item you're working on (task_bind).",
    );
  });
  it("rules cover bind-first, one per session, rebind, relay subagent reports", () => {
    for (const w of ["BEFORE", "One bound item per session", "Rebind", "relay the decisions and findings", "not kept in memory"]) expect(BINDING_RULES).toContain(w);
  });
  it("status label: short title or unbound", () => {
    expect(bindingLabel(null)).toBe("⛓ unbound");
    expect(bindingLabel("Short")).toBe("⛓ Short");
    expect(bindingLabel("x".repeat(60)).length).toBeLessThanOrEqual(30);
    expect(bindingLabel("x".repeat(60)).endsWith("…")).toBe(true);
  });
});

describe("recordFeatureId", () => {
  const client = (items: Record<string, any>) => ({ get: async (id: string) => { if (!items[id]) throw new Error("404"); return items[id]; } });
  it("is the parent only when it is a real feature", async () => {
    const c = client({ f: { id: "f", kind: "feature" }, inbox: { id: "inbox", kind: "feature", container: true } });
    expect(await recordFeatureId(c as any, { partOf: "f" })).toBe("f");
    expect(await recordFeatureId(c as any, { partOf: "inbox" })).toBeUndefined();
    expect(await recordFeatureId(c as any, { partOf: "gone" })).toBeUndefined();
    expect(await recordFeatureId(c as any, {})).toBeUndefined();
  });
});
