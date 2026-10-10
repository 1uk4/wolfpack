import { describe, it, expect } from "vitest";
import type { WorkItem } from "@wolfpack/kb/client";
import { workspaceHeader } from "./workspace.js";

let n = 0;
const w = (kind: string, stage: string, partOf: string | null = null, extra: Partial<WorkItem> = {}) =>
  ({ id: `w${++n}`, kind, stage, partOf, title: `${kind}${n}`, dependsOn: [], container: false, ...extra }) as unknown as WorkItem;

describe("workspaceHeader", () => {
  const init = w("initiative", "in_build", null, { title: "Memory Extension Polish" });
  const f = w("feature", "in_build", init.id, { title: "Repo Cleanup", successCriteria: "dead code gone" });
  const a = w("task", "in_build", f.id, { title: "reorg lock" });
  const b = w("task", "plan", f.id, { title: "validate ledger", dependsOn: [a.id] } as any);
  const c = w("task", "shipped", f.id, { title: "docs" });
  const all = [init, f, a, b, c];

  it("names the feature, initiative, goal, progress and open tasks (bound / blocked)", () => {
    const h = workspaceHeader(f.id, all, a.id)!;
    expect(h).toContain("Feature: Repo Cleanup [in_build] · 1/3 tasks done");
    expect(h).toContain("Initiative: Memory Extension Polish");
    expect(h).toContain("Feature done when: dead code gone");
    expect(h).toContain("● (bound) reorg lock [in_build]");
    expect(h).toContain("⛔ validate ledger [plan]");
    expect(h).not.toContain("docs");
  });

  it("is null for no workspace or a non-feature; labels the Inbox", () => {
    expect(workspaceHeader(null, all)).toBeNull();
    expect(workspaceHeader(init.id, all)).toBeNull();
    const inbox = w("feature", "in_build", null, { container: true, title: "Inbox" });
    expect(workspaceHeader(inbox.id, [inbox])).toContain("Inbox (holding area for unfiled work)");
  });
});
