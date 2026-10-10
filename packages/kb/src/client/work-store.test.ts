import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KbRoots } from "../shared/index.js";
import {
  commitWorkItem,
  resolveWorkItem,
  listWorkItems,
  appendWorkLedger,
  readWorkLedger,
  loadWorkState,
} from "./work-store.js";
import { WorkId, WolfId, type WorkItem, type WorkEvent } from "../schema/work.js";
import { DomainId, Slug, IsoDate } from "../schema/knowledge.js";

function makeRoots(): KbRoots {
  const base = mkdtempSync(join(tmpdir(), "kb-work-test-"));
  return {
    kbBase: join(base, "base"),
    opsRoot: join(base, "ops"),
    denLocal: join(base, "den"),
  };
}

const testItem: WorkItem = {
  id: WorkId.parse("work-snapjack-Ft00001"),
  nodeType: "work",
  kind: "feature",
  domain: DomainId.parse("snapjack"),
  area: Slug.parse("marketing"),
  title: "referral program",
  summary: null,
  stage: "plan",
  assignee: WolfId.parse("1uk4"),
  successCriteria: "users can redeem referral codes",
  partOf: null,
  references: [],
  dependsOn: [],
  blocks: [],
  graduatedTo: [],
  container: false,
  log: [],
  created: IsoDate.parse("2026-10-09"),
  updated: IsoDate.parse("2026-10-09"),
};

describe("work-store", () => {
  let roots: KbRoots;
  beforeEach(() => { roots = makeRoots(); });

  describe("commitWorkItem + resolveWorkItem", () => {
    it("round-trips a work item through markdown", () => {
      commitWorkItem(roots, testItem);
      const resolved = resolveWorkItem(roots, "snapjack", "work-snapjack-Ft00001");
      expect(resolved).not.toBeNull();
      expect(resolved!.item.id).toBe("work-snapjack-Ft00001");
      expect(resolved!.item.kind).toBe("feature");
      expect(resolved!.item.area).toBe("marketing");
      expect(resolved!.item.title).toBe("referral program");
      expect(resolved!.item.successCriteria).toBe("users can redeem referral codes");
    });

    it("preserves body content", () => {
      commitWorkItem(roots, testItem, "Custom plan content here.");
      const resolved = resolveWorkItem(roots, "snapjack", "work-snapjack-Ft00001");
      expect(resolved!.body).toContain("Custom plan content here.");
    });
  });

  describe("listWorkItems", () => {
    it("returns empty for non-existent domain", () => {
      expect(listWorkItems(roots, "nonexistent")).toEqual([]);
    });

    it("lists committed items", () => {
      commitWorkItem(roots, testItem);
      const ids = listWorkItems(roots, "snapjack");
      expect(ids).toContain("work-snapjack-Ft00001");
    });
  });

  describe("work ledger", () => {
    it("appends and reads events", () => {
      const events: WorkEvent[] = [
        {
          type: "work.created",
          id: WorkId.parse("work-snapjack-Ft00001"),
          at: "2026-10-09 10:00",
          kind: "feature",
          domain: DomainId.parse("snapjack"),
          title: "referral program",
          assignee: WolfId.parse("1uk4"),
          area: Slug.parse("marketing"),
          partOf: null,
          successCriteria: null,
          stage: "plan",
          container: false,
        },
        {
          type: "work.staged",
          id: WorkId.parse("work-snapjack-Ft00001"),
          at: "2026-10-09 11:00",
          to: "in_build",
        },
      ];

      appendWorkLedger(roots, events);
      const read = readWorkLedger(roots);
      expect(read).toHaveLength(2);
      expect(read[0].type).toBe("work.created");
      expect(read[1].type).toBe("work.staged");
    });

    it("loadWorkState folds the ledger", () => {
      const events: WorkEvent[] = [
        {
          type: "work.created",
          id: WorkId.parse("work-snapjack-Ft00001"),
          at: "2026-10-09 10:00",
          kind: "feature",
          domain: DomainId.parse("snapjack"),
          title: "referral program",
          assignee: WolfId.parse("1uk4"),
          area: null,
          partOf: null,
          successCriteria: null,
          stage: "plan",
          container: false,
        },
      ];
      appendWorkLedger(roots, events);
      const state = loadWorkState(roots);
      expect(state.size).toBe(1);
      expect(state.get(WorkId.parse("work-snapjack-Ft00001"))!.title).toBe("referral program");
    });

    it("returns empty state for non-existent ledger", () => {
      expect(loadWorkState(roots).size).toBe(0);
    });
  });
});
