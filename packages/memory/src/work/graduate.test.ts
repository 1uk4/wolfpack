import { describe, it, expect } from "vitest";
import type { WorkItem } from "@wolfpack/kb/client";
import { featureDossier, graduationFile, graduationEntryId, archiveSet } from "./graduate.js";

const item = (over: Partial<WorkItem>) =>
  ({ id: "work-wp-Feat001", kind: "feature", domain: "wp", title: "Feat", successCriteria: null, log: [], ...over }) as unknown as WorkItem;

describe("graduation contributions", () => {
  it("entry id is kb-<domain>-<7id>", () => {
    expect(graduationEntryId(item({}))).toBe("kb-wp-Feat001");
  });

  it("dossier has the goal, document and task notes, without work ids or process notes", () => {
    const task = item({
      id: "work-wp-Task001", kind: "task", title: "Build the panel", successCriteria: "panel renders",
      log: [
        { at: "x", text: "Built in abc123: added selector.ts (see work-wp-Task002)." },
        { at: "x", text: "Stage: plan → in_build" },
        { at: "x", text: "Completed." },
      ],
    } as any);
    const d = featureDossier(item({ successCriteria: "panel works" }), "# Feat\n\n## Plan\nUse two panes.\n_Completed 2026-10-10_\n", [task]);
    expect(d).toContain("Goal: panel works");
    expect(d).toContain("Use two panes.");
    expect(d).toContain("### Build the panel");
    expect(d).toContain("Done when: panel renders");
    expect(d).toContain("added selector.ts");
    expect(d).not.toMatch(/work-wp-|Stage: |Completed\.|_Completed/);
  });

  it("file names its entry and graduation kind", () => {
    const f = graduationFile({ from: "1uk4", item: item({}), graduation: "hub", body: "b", final: true, submitted: new Date(0) });
    expect(f.name).toBe("grad-hub-work-wp-Feat001-0.md");
    expect(f.content).toMatch(/graduation: hub\nentry_id: kb-wp-Feat001\nfinal: true\n/);
    expect(f.content).toContain("den_topic_id: work-wp-Feat001");
  });
});

describe("archiveSet", () => {
  it("is the item plus everything under it not already archived", () => {
    const init = item({ id: "work-wp-Init001", kind: "initiative", stage: "in_build" } as any);
    const f = item({ id: "work-wp-Feat001", partOf: init.id, stage: "shipped" } as any);
    const t1 = item({ id: "work-wp-Task001", kind: "task", partOf: f.id, stage: "shipped" } as any);
    const t2 = item({ id: "work-wp-Task002", kind: "task", partOf: f.id, stage: "archived" } as any);
    const all = [init, f, t1, t2];
    expect(archiveSet(f, all).map((i) => i.id)).toEqual([f.id, t1.id]);
    expect(archiveSet(init, all).map((i) => i.id)).toEqual([init.id, f.id, t1.id]);
  });
});
