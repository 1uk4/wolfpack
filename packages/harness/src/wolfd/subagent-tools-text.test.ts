/** The subagent tool texts tell the parent that a shipped worktree child is merged automatically. */
import { describe, expect, it } from "vitest";
import { createSubagentExtension } from "./subagent-tools.js";

const RULE = "When the child's task is shipped (task_done), its branch is merged into the feature branch automatically. Don't merge by hand; use subagent_merge only after a merge conflict or when asked.";

describe("subagent tool descriptions", () => {
  const tools = createSubagentExtension({ require: () => ({}) } as never, { wolfDen: "/tmp", wolfName: "w" }).flatMap((e) => e.tools ?? []);
  const desc = (n: string) => (tools.find((t) => t.name === n) as unknown as { description: string }).description;
  it("subagent and subagent_merge carry the automatic-merge rule", () => {
    expect(desc("subagent")).toContain(RULE);
    expect(desc("subagent_merge")).toContain(RULE);
  });
});
