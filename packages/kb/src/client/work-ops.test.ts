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
  ensureInbox,
  moveWork,
  unlinkWork,
  graduateWork,
} from "./work-ops.js";
import { loadWorkState, readWorkLedger, resolveWorkItem, commitWorkItem } from "./work-store.js";

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

    // A parentless task is filed in the domain's Inbox (created on first use).
    const events = readWorkLedger(roots);
    expect(events.map((e) => e.type)).toEqual(["work.created", "work.created"]);
    const inbox = loadWorkState(roots).get(result.item.partOf!)!;
    expect(inbox).toMatchObject({ kind: "feature", title: "Inbox", container: true, domain: "snapjack" });
    expect(loadWorkState(roots).size).toBe(2);
  });

  it("createWork treats a blank partOf as a root item", () => {
    for (const partOf of ["", "  "]) {
      const { item } = createWork(roots, {
        kind: "feature",
        domain: "wolfpack",
        title: `root ${JSON.stringify(partOf)}`,
        assignee: "1uk4",
        partOf,
      });
      expect(item.partOf).toBeNull();
    }
    expect(loadWorkState(roots).size).toBe(2);
  });

  it("createWork rejects an invalid event without touching the ledger", () => {
    createWork(roots, { kind: "task", domain: "wolfpack", title: "ok", assignee: "1uk4" });

    expect(() =>
      createWork(roots, { kind: "task", domain: "wolfpack", title: "bad", assignee: "1uk4", partOf: "not-a-work-id" })
    ).toThrow(/parent work item not-a-work-id not found/);
    expect(() =>
      createWork(roots, { kind: "task", domain: "wolfpack", title: "", assignee: "1uk4" })
    ).toThrow(/title/);

    expect(readWorkLedger(roots)).toHaveLength(2); // Inbox + "ok"
  });

  it("noteWork rejects empty text without touching the ledger", () => {
    const { id } = createWork(roots, { kind: "task", domain: "wolfpack", title: "t", assignee: "1uk4" });
    expect(() => noteWork(roots, id, "")).toThrow(/Invalid work\.noted event/);
    expect(readWorkLedger(roots)).toHaveLength(2); // Inbox + "t"
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

  it("stageWork to the current stage records nothing", () => {
    const { id } = createWork(roots, { kind: "task", domain: "wolfpack", title: "t", assignee: "1uk4", successCriteria: "ok" });
    stageWork(roots, id, "shipped");
    const before = readWorkLedger(roots).length;

    const again = stageWork(roots, id, "shipped");

    expect(again.event).toBeNull();
    expect(again.item.stage).toBe("shipped");
    expect(readWorkLedger(roots)).toHaveLength(before);
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

  it("linkWork refuses links to KB entries", () => {
    const { id } = createWork(roots, {
      kind: "task",
      domain: "snapjack",
      title: "test",
      assignee: "1uk4",
    });

    const before = readWorkLedger(roots).length;
    expect(() => linkWork(roots, id, "references", "kb-snapjack-aB3xZ9k")).toThrow(/only link to each other/);
    expect(() => linkWork(roots, id, "graduated_to", "kb-snapjack-aB3xZ9k")).toThrow(/only link to each other/);
    expect(() => unlinkWork(roots, id, "references", "kb-snapjack-aB3xZ9k")).toThrow(/only link to each other/);
    expect(readWorkLedger(roots)).toHaveLength(before);
  });

  it("graduateWork records the date once and links nothing", () => {
    const { id } = createWork(roots, { kind: "feature", domain: "snapjack", title: "f", assignee: "1uk4" });
    const first = graduateWork(roots, id);
    expect(first.item.graduated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(graduateWork(roots, id).event).toBeNull();
    expect(resolveWorkItem(roots, "snapjack", id)!.item.graduated).toBe(first.item.graduated);
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
    createWork(roots, { kind: "feature", domain: "snapjack", title: "a", assignee: "1uk4" });
    createWork(roots, { kind: "feature", domain: "snapjack", title: "b", assignee: "hal" });
    createWork(roots, { kind: "feature", domain: "personal", title: "c", assignee: "1uk4" });

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

  describe("hierarchy", () => {
    const mk = (kind: string, partOf?: string, domain = "wolfpack") =>
      createWork(roots, { kind: kind as any, domain, title: `${kind} ${Math.random()}`, assignee: "1uk4", partOf }).item;

    it("allows initiative → feature → task, and standalone features", () => {
      const init = mk("initiative");
      const feat = mk("feature", init.id);
      expect(mk("task", feat.id).partOf).toBe(feat.id);
      expect(mk("issue", feat.id).partOf).toBe(feat.id);
      expect(mk("spike", mk("feature").id).kind).toBe("spike");
      expect(mk("idea").partOf).toBeNull();
    });

    it("rejects tasks under initiatives or tasks, and parents for initiatives/ideas", () => {
      const init = mk("initiative");
      const feat = mk("feature", init.id);
      const task = mk("task", feat.id);
      const before = readWorkLedger(roots).length;

      expect(() => mk("task", init.id)).toThrow(/only sit under a feature/);
      expect(() => mk("task", task.id)).toThrow(/only sit under a feature/);
      expect(() => mk("feature", feat.id)).toThrow(/only sit under an initiative/);
      expect(() => mk("initiative", init.id)).toThrow(/cannot have a parent/);
      expect(() => mk("idea", feat.id)).toThrow(/cannot have a parent/);
      expect(() => mk("task", mk("feature", undefined, "snapjack").id)).toThrow(/domain/);
      expect(readWorkLedger(roots)).toHaveLength(before + 1); // only the snapjack feature
    });
  });

  describe("inbox", () => {
    it("is one container per domain, created on first use", () => {
      const a = createWork(roots, { kind: "task", domain: "wolfpack", title: "a", assignee: "1uk4" }).item;
      const b = createWork(roots, { kind: "spike", domain: "wolfpack", title: "b", assignee: "1uk4" }).item;
      const c = createWork(roots, { kind: "issue", domain: "personal", title: "c", assignee: "1uk4" }).item;

      expect(a.partOf).toBe(b.partOf);
      expect(c.partOf).not.toBe(a.partOf);
      expect(ensureInbox(roots, "wolfpack", "1uk4").id).toBe(a.partOf);
      expect([...loadWorkState(roots).values()].filter((i) => i.container)).toHaveLength(2);
    });

    it("never ships", () => {
      const inbox = ensureInbox(roots, "wolfpack", "1uk4");
      expect(() => stageWork(roots, inbox.id, "shipped")).toThrow(/never ships/);
    });
  });

  describe("moveWork", () => {
    it("re-parents a task, keeps its body, and records one event", () => {
      const feat = createWork(roots, { kind: "feature", domain: "wolfpack", title: "f", assignee: "1uk4" }).item;
      const task = createWork(roots, { kind: "task", domain: "wolfpack", title: "t", assignee: "1uk4" }).item;
      commitWorkItem(roots, task, "## Plan\nkeep me");

      const { item } = moveWork(roots, task.id, feat.id);

      expect(item.partOf).toBe(feat.id);
      expect(resolveWorkItem(roots, "wolfpack", task.id)?.body).toContain("keep me");
      expect(readWorkLedger(roots).at(-1)).toMatchObject({ type: "work.moved", partOf: feat.id });
      expect(moveWork(roots, task.id, feat.id).event).toBeNull(); // already there
    });

    it("validates the target and refuses to move the Inbox", () => {
      const init = createWork(roots, { kind: "initiative", domain: "wolfpack", title: "i", assignee: "1uk4" }).item;
      const task = createWork(roots, { kind: "task", domain: "wolfpack", title: "t", assignee: "1uk4" }).item;
      const before = readWorkLedger(roots).length;

      expect(() => moveWork(roots, task.id, init.id)).toThrow(/only sit under a feature/);
      expect(() => moveWork(roots, task.id, null)).toThrow(/needs a feature/);
      expect(() => moveWork(roots, task.partOf!, init.id)).toThrow(/cannot be moved/);
      expect(readWorkLedger(roots)).toHaveLength(before);
    });

    it("moves a feature under an initiative and back to standalone", () => {
      const init = createWork(roots, { kind: "initiative", domain: "wolfpack", title: "i", assignee: "1uk4" }).item;
      const feat = createWork(roots, { kind: "feature", domain: "wolfpack", title: "f", assignee: "1uk4" }).item;
      expect(moveWork(roots, feat.id, init.id).item.partOf).toBe(init.id);
      expect(moveWork(roots, feat.id, null).item.partOf).toBeNull();
    });
  });

  describe("dependencies", () => {
    const mk = (kind: string, partOf?: string) =>
      createWork(roots, { kind: kind as any, domain: "wolfpack", title: `${kind}-${Math.random().toString(36).slice(2, 6)}`, assignee: "1uk4", partOf }).item;

    it("allows tasks in the same feature and features under the same initiative", () => {
      const init = mk("initiative");
      const [f1, f2] = [mk("feature", init.id), mk("feature", init.id)];
      const [a, b] = [mk("task", f1.id), mk("task", f1.id)];
      expect(linkWork(roots, b.id, "depends_on", a.id).item.dependsOn).toEqual([a.id]);
      expect(linkWork(roots, f2.id, "depends_on", f1.id).item.dependsOn).toEqual([f1.id]);
      expect(linkWork(roots, b.id, "depends_on", a.id).event).toBeNull(); // already there
    });

    it("refuses cross-feature, cross-initiative, standalone-feature, mixed-kind and initiative links", () => {
      const [i1, i2] = [mk("initiative"), mk("initiative")];
      const [f1, f2, g1] = [mk("feature", i1.id), mk("feature", i1.id), mk("feature", i2.id)];
      const solo = mk("feature");
      const [t1, t2] = [mk("task", f1.id), mk("task", f2.id)];
      const before = readWorkLedger(roots).length;
      expect(() => linkWork(roots, t1.id, "depends_on", t2.id)).toThrow(/same feature/);
      expect(() => linkWork(roots, f1.id, "depends_on", g1.id)).toThrow(/same initiative/);
      expect(() => linkWork(roots, solo.id, "depends_on", f1.id)).toThrow(/same initiative/);
      expect(() => linkWork(roots, t1.id, "depends_on", f1.id)).toThrow(/only depend on a task/);
      expect(() => linkWork(roots, f1.id, "depends_on", t1.id)).toThrow(/another feature/);
      expect(() => linkWork(roots, i1.id, "depends_on", i2.id)).toThrow(/cannot have dependencies/);
      expect(() => linkWork(roots, t1.id, "depends_on", t1.id)).toThrow(/itself/);
      expect(readWorkLedger(roots)).toHaveLength(before);
    });

    it("refuses cycles, direct and transitive", () => {
      const f = mk("feature");
      const [a, b, c] = [mk("task", f.id), mk("task", f.id), mk("task", f.id)];
      linkWork(roots, b.id, "depends_on", a.id);
      linkWork(roots, c.id, "depends_on", b.id);
      expect(() => linkWork(roots, a.id, "depends_on", b.id)).toThrow(/cycle/);
      expect(() => linkWork(roots, a.id, "depends_on", c.id)).toThrow(/cycle/);
    });

    it("records `A blocks B` as `B depends_on A`, and unlinks", () => {
      const f = mk("feature");
      const [a, b] = [mk("task", f.id), mk("task", f.id)];
      linkWork(roots, a.id, "blocks", b.id);
      const state = () => loadWorkState(roots);
      expect(state().get(b.id)!.dependsOn).toEqual([a.id]);
      expect(state().get(a.id)!.blocks).toEqual([]);
      expect(unlinkWork(roots, b.id, "depends_on", a.id).item.dependsOn).toEqual([]);
      expect(unlinkWork(roots, b.id, "depends_on", a.id).event).toBeNull();
      expect(readWorkLedger(roots).at(-1)).toMatchObject({ type: "work.unlinked", rel: "depends_on", target: a.id });
    });
  });
});
