import { describe, it, expect } from "vitest";
import type { ParsedContribution } from "../shared/index.js";
import { produceVerbatim } from "./produce-verbatim.js";
import { ANCHOR_BODY_CAP } from "./sweep-size.js";
import type { ProduceEntryInput } from "./produce.js";

const WID = "work-wolfpack-AbCdEf1";
const input = (body: string, entryId?: string, existingMarkdown?: string): ProduceEntryInput =>
  ({
    contribution: { from: "w", denTopicId: "t", body, summary: "sum", anchor: WID, verbatim: true, contentHash: "sha256:a", change: "create", prevHash: null, filePath: "/tmp/t.md" } as unknown as ParsedContribution,
    domain: "wolfpack",
    section: "sec-wolfpack-abc123",
    placement: { basis: "routed", fit: 1 },
    entryId,
    existingMarkdown,
    resolve: () => undefined,
  }) as unknown as ProduceEntryInput;

const prev = `---\nid: kb-wolfpack-AAAAAAA\nanchor: ${WID}\ncreated: 2026-01-01\n---\n\n# T\n\nbody\n\n## History\n\n- 2026-01-02 older line\n`;

describe("produceVerbatim History and size", () => {
  it("keeps existing History lines, adds the cited line once, and a second run does not duplicate", () => {
    const body = `# T\n\nnew body\n\n## History\n\n- 2026-02-01 shipped work-wolfpack-ZzZzZz9\n`;
    const r1 = produceVerbatim(input(body, "kb-wolfpack-AAAAAAA", prev));
    expect(r1.entry.detail).toContain("- 2026-01-02 older line");
    expect(r1.entry.detail).toContain("work-wolfpack-ZzZzZz9");
    const r2 = produceVerbatim(input(body, "kb-wolfpack-AAAAAAA", `---\nid: kb-wolfpack-AAAAAAA\nanchor: ${WID}\n---\n\n# T\n\n${r1.entry.summary}\n\n${r1.entry.detail}\n`));
    expect(r2.entry.detail.split("work-wolfpack-ZzZzZz9").length).toBe(2);
  });

  it("over the anchor cap, History folds into an un-anchored ~history child and the parent keeps a pointer", () => {
    const body = `# T\n\n${"x".repeat(ANCHOR_BODY_CAP - 500)}\n\n## History\n\n- 2026-02-01 ${"h".repeat(1000)}\n`;
    const r = produceVerbatim(input(body, "kb-wolfpack-AAAAAAA", prev));
    expect(r.historyChild?.id).toBe("kb-wolfpack-AAAAAAA~history");
    expect(r.historyChild?.title).toMatch(/^T: history digest \(\d{4}-\d{2}-\d{2}\)$/);
    expect(r.entry.detail).toContain("History: see [[kb-wolfpack-AAAAAAA~history]]");
    expect(r.entry.detail.length).toBeLessThan(ANCHOR_BODY_CAP);
    expect(r.historyChild?.body).toContain("older line");
    expect(r.entry.anchor).toBe(WID);
    expect((r.historyChild as unknown as { anchor?: string }).anchor).toBeUndefined();
  });
});
