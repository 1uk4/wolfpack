import { describe, it, expect, afterEach } from "vitest";
import type { ParsedContribution } from "../shared/index.js";
import { BODY_CAP, maxMergeTargetCharsFor, mergeSizeLimit, notifyKeptOversize, shouldRoutePlacement } from "./sweep-size.js";

const contrib = (denTopicId: string): ParsedContribution =>
  ({ from: "w", denTopicId, filePath: "/tmp/x/" + denTopicId + ".md", body: "", summary: "s", contentHash: "sha256:a", change: "create", prevHash: null } as unknown as ParsedContribution);

afterEach(() => { delete process.env.KB_MAX_MERGE_TARGET_CHARS; });

describe("sweep-size", () => {
  it("merge limit is twice the body cap whatever the budget, and the env override wins", () => {
    expect(maxMergeTargetCharsFor(600_000)).toBe(12_000);
    expect(maxMergeTargetCharsFor(1)).toBe(12_000);
    process.env.KB_MAX_MERGE_TARGET_CHARS = "9000";
    expect(mergeSizeLimit(maxMergeTargetCharsFor(1))).toBe(9000);
  });

  it("split parts may not split again (overflow stays off for ~split- parts)", () => {
    expect(shouldRoutePlacement(contrib("t~split-a"))).toBe(false);
    expect(shouldRoutePlacement(contrib("t"))).toBe(true);
  });

  it("an oversize non-anchor entry queues its later sections as ~split- parts", () => {
    const detail = `## A\n${"a".repeat(4000)}\n## B\n${"b".repeat(4000)}\n`;
    const parts = notifyKeptOversize(undefined, contrib("topic"), "kb-x-1234567", detail.length, detail);
    expect(parts.map((p) => p.denTopicId)).toEqual(["topic~split-b"]);
    expect(parts[0].anchor).toBeUndefined();
    expect(BODY_CAP).toBe(6000);
  });

  it("a part that is itself over cap is kept with the note, not re-split", () => {
    const msgs: string[] = [];
    const detail = `## A\n${"a".repeat(4000)}\n## B\n${"b".repeat(4000)}\n`;
    const parts = notifyKeptOversize((m) => msgs.push(m), contrib("topic~split-a"), "kb-x-1234567", detail.length, detail);
    expect(parts).toEqual([]);
    expect(msgs[0]).toContain("kept oversize");
  });
});
