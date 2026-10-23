import { describe, it, expect } from "vitest";
import {
  UNBOUND_CONTEXT,
  BINDING_RULES,
  shouldBindOnCreate,
  notBoundReason,
  bindingLabel,
  readyBoundContext,
  readyBoundReply,
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
  it("a finished feature or loose task: the label says ready to graduate, the context and reply say where talk goes", () => {
    expect(bindingLabel("Compose stack", 28, true)).toBe("⛓ Compose stack · ready to graduate");
    expect(readyBoundContext({ title: "Compose stack", kind: "feature" })).toBe(
      "Bound to Compose stack — all tasks done, ready to graduate (press g / task_graduate). Follow-up discussion goes to its Record.",
    );
    expect(readyBoundContext({ title: "Stray fix", kind: "task" })).toContain("Bound to Stray fix — shipped, ready to graduate");
    expect(readyBoundReply({ title: "Compose stack", kind: "feature" })).toBe("Bound to Compose stack (all tasks done — ready to graduate)");
    expect(readyBoundReply({ title: "Stray fix", kind: "task" })).toBe("Bound to Stray fix (shipped — ready to graduate)");
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

describe("createSerial", () => {
  it("runs jobs one at a time, in order, even when one fails", async () => {
    const { createSerial } = await import("./binding.js");
    const serial = createSerial();
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) => serial(async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    });
    const results = await Promise.allSettled([job("a", 20, true), job("b", 1), job("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });
});
