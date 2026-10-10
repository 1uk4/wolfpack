import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KbRoots } from "../shared/index.js";
import {
  createWork,
  stageWork,
  assignWork,
  noteWork,
  linkWork,
  setCriteria,
  retitleWork,
  deleteWork,
  queryWork,
  getWorkTree,
} from "./work-ops.js";
import { loadWorkState, readWorkLedger, resolveWorkItem } from "./work-store.js";

function makeRoots(): KbRoots {
  const base = mkdtempSync(join(tmpdir(), "kb-ops-test-"));
  return {
    kbBase: join(base, "base"),
    opsRoot: join(base, "ops"),
    denLocal: join(base, "den"),
  };
}

describe("work-ops", () => {
  let roots: KbRoots;
  beforeEach(() => { roots = makeRoots(); });

  it("createWork produces an item, event, and file", () => {
    const result = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "wire referral codes",
      assignee: "1uk4",
      area: "marketing",
      successCriteria: "code redeems → credit applied",
    });

    expect(result.id).toMatch(/^work-snapjack-/);
    expect(result.item.kind).toBe("task");
    expect(result.item.stage).toBe("plan");
    expect(result.item.assignee).toBe("1uk4");

    const events = readWorkLedger(roots);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("work.created");

    const state = loadWorkState(roots);
    expect(state.size).toBe(1);
  });

  it("stageWork advances the stage", () => {
    const { id } = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "test task",
      assignee: "1uk4",
      successCriteria: "it works",
    });

    const { item } = stageWork(roots, id, "in_build");
    expect(item.stage).toBe("in_build");
  });

  it("stageWork blocks a task without criteria", () => {
    const { id } = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "no criteria task",
      assignee: "1uk4",
    });

    expect(() => stageWork(roots, id, "in_build")).toThrow(/success_criteria/);
  });

  it("assignWork changes the assignee", () => {
    const { id } = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "test",
      assignee: "1uk4",
    });

    const { item } = assignWork(roots, id, "hal");
    expect(item.assignee).toBe("hal");
  });

  it("noteWork appends to the log", () => {
    const { id } = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "test",
      assignee: "1uk4",
    });

    noteWork(roots, id, "started working on it");
    const { item } = noteWork(roots, id, "halfway done");
    expect(item.log).toHaveLength(2);
    expect(item.log[1].text).toBe("halfway done");
  });

  it("linkWork adds references", () => {
    const { id } = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "test",
      assignee: "1uk4",
    });

    const { item } = linkWork(roots, id, "references", "kb-snapjack-aB3xZ9k");
    expect(item.references).toHaveLength(1);
  });

  it("setCriteria updates success criteria", () => {
    const { id } = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "test",
      assignee: "1uk4",
    });

    const { item } = setCriteria(roots, id, "all tests pass");
    expect(item.successCriteria).toBe("all tests pass");
  });

  it("retitleWork changes the title", () => {
    const { id } = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "old title",
      assignee: "1uk4",
    });

    const { item } = retitleWork(roots, id, "new title");
    expect(item.title).toBe("new title");
  });

  it("queryWork filters by domain and assignee", () => {
    createWork(roots, { kind: "task", domain: "snapjack", title: "a", assignee: "1uk4" });
    createWork(roots, { kind: "task", domain: "snapjack", title: "b", assignee: "hal" });
    createWork(roots, { kind: "task", domain: "personal", title: "c", assignee: "1uk4" });

    expect(queryWork(roots, { domain: "snapjack" })).toHaveLength(2);
    expect(queryWork(roots, { assignee: "1uk4" })).toHaveLength(2);
    expect(queryWork(roots, { domain: "snapjack", assignee: "hal" })).toHaveLength(1);
    expect(queryWork(roots)).toHaveLength(3);
  });

  it("getWorkTree returns the item and its children", () => {
    const parent = createWork(roots, {
      kind: "initiative",
      domain: "snapjack",
      title: "Q2 launch",
      assignee: "1uk4",
    });
    createWork(roots, {
      kind: "feature",
      domain: "snapjack",
      title: "referral program",
      assignee: "1uk4",
      partOf: parent.id,
    });
    createWork(roots, {
      kind: "task",
      domain: "personal",
      title: "unrelated",
      assignee: "1uk4",
    });

    const tree = getWorkTree(roots, parent.id);
    expect(tree).toHaveLength(2);
    expect(tree[0].title).toBe("Q2 launch");
  });

  it("deleteWork removes an item and all children", () => {
    const parent = createWork(roots, {
      kind: "initiative",
      domain: "snapjack",
      title: "Q2 launch",
      assignee: "1uk4",
    });
    const child = createWork(roots, {
      kind: "feature",
      domain: "snapjack",
      title: "referral program",
      assignee: "1uk4",
      partOf: parent.id,
    });
    const unrelated = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "unrelated",
      assignee: "1uk4",
    });

    const result = deleteWork(roots, parent.id);

    expect(result.items.map((i) => i.id)).toEqual([parent.id, child.id]);
    expect(loadWorkState(roots).has(parent.id)).toBe(false);
    expect(loadWorkState(roots).has(child.id)).toBe(false);
    expect(loadWorkState(roots).has(unrelated.id)).toBe(true);
    expect(resolveWorkItem(roots, "snapjack", parent.id)).toBeNull();
    expect(resolveWorkItem(roots, "snapjack", child.id)).toBeNull();
    expect(readWorkLedger(roots).filter((e) => e.type === "work.deleted")).toHaveLength(2);
  });

  it("throws on unknown work item", () => {
    expect(() => stageWork(roots, "work-snapjack-NoSuch0", "in_build")).toThrow(/not found/);
  });
});
