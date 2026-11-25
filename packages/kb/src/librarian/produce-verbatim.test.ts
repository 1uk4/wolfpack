import { describe, it, expect } from "vitest";
import type { ParsedContribution } from "../shared/index.js";
import { produceVerbatim } from "./produce-verbatim.js";
import { ANCHOR_BODY_CAP } from "./sweep-size.js";
import type { ProduceEntryInput } from "./produce.js";

const WID = "work-wolfpack-AbCdEf1";
const CHILD = "kb-wolfpack-CCCCCCC";
const input = (body: string, entryId?: string, existingMarkdown?: string, existingHistoryMarkdown?: string): ProduceEntryInput & { existingHistoryMarkdown?: string } =>
  ({
    contribution: { from: "w", denTopicId: "t", body, summary: "sum", anchor: WID, verbatim: true, contentHash: "sha256:a", change: "create", prevHash: null, filePath: "/tmp/t.md" } as unknown as ParsedContribution,
    domain: "wolfpack",
    section: "sec-wolfpack-abc123",
    placement: { basis: "routed", fit: 1 },
    entryId,
    existingMarkdown,
    existingHistoryMarkdown,
    resolve: () => undefined,
  }) as unknown as ProduceEntryInput;

const prev = `---\nid: kb-wolfpack-AAAAAAA\nanchor: ${WID}\ncreated: 2026-01-01\n---\n\n# T\n\nbody\n\n## History\n\n- 2026-01-02 older line\n`;
// A parent already folded: only the pointer is left, its History is in the child.
const folded = `---\nid: kb-wolfpack-AAAAAAA\nanchor: ${WID}\nhistoryChild: ${CHILD}\ncreated: 2026-01-01\n---\n\n# T\n\nbody\n\nHistory: see [[${CHILD}]]\n`;
const childMd = `---\nid: ${CHILD}\nhistoryOf: kb-wolfpack-AAAAAAA\n---\n\n# T: history digest\n\nsum\n\n## History\n\n- 2026-01-02 older line\n- 2026-01-03 second line\n`;
const pointers = (s: string) => s.split(`[[${CHILD}]]`).length - 1;

describe("produceVerbatim History and size", () => {
  it("keeps existing History lines, adds the cited line once, and a second run does not duplicate", () => {
    const body = `# T\n\nnew body\n\n## History\n\n- 2026-02-01 shipped work-wolfpack-ZzZzZz9\n`;
    const r1 = produceVerbatim(input(body, "kb-wolfpack-AAAAAAA", prev));
    expect(r1.entry.detail).toContain("- 2026-01-02 older line");
    expect(r1.entry.detail).toContain("work-wolfpack-ZzZzZz9");
    const r2 = produceVerbatim(input(body, "kb-wolfpack-AAAAAAA", `---\nid: kb-wolfpack-AAAAAAA\nanchor: ${WID}\n---\n\n# T\n\n${r1.entry.summary}\n\n${r1.entry.detail}\n`));
    expect(r2.entry.detail.split("work-wolfpack-ZzZzZz9").length).toBe(2);
  });

  it("over the anchor cap, History folds into a minted-id child linked by historyChild, and the parent keeps one pointer", () => {
    const body = `# T\n\n${"x".repeat(ANCHOR_BODY_CAP - 500)}\n\n## History\n\n- 2026-02-01 ${"h".repeat(1000)}\n`;
    const r = produceVerbatim(input(body, "kb-wolfpack-AAAAAAA", prev));
    expect(r.historyChild?.id).toMatch(/^kb-wolfpack-[0-9A-Za-z]{7}$/);
    expect(r.historyChild?.title).toMatch(/^T: history digest \(\d{4}-\d{2}-\d{2}\)$/);
    expect(r.entry.historyChild).toBe(r.historyChild?.id);
    expect(r.entry.detail).toContain(`History: see [[${r.historyChild?.id}]]`);
    expect(r.entry.detail.length).toBeLessThan(ANCHOR_BODY_CAP);
    expect(r.historyChild?.body).toContain("older line");
    expect(r.entry.anchor).toBe(WID);
  });

  it("a second update over an already-folded parent appends to the child (no earlier line lost) and keeps exactly one pointer", () => {
    const body = `# T\n\n${"x".repeat(ANCHOR_BODY_CAP)}\n\n## History\n\n- 2026-02-01 newest line\n`;
    const r = produceVerbatim(input(body, "kb-wolfpack-AAAAAAA", folded, childMd));
    expect(r.historyChild?.id).toBe(CHILD);
    for (const l of ["older line", "second line", "newest line"]) expect(r.historyChild?.body).toContain(l);
    expect(pointers(r.entry.detail)).toBe(1);
    expect(r.entry.historyChild).toBe(CHILD);
  });

  it("an update under the cap keeps the pointer and the child link instead of orphaning the child", () => {
    const r = produceVerbatim(input(`# T\n\nsmall new body\n`, "kb-wolfpack-AAAAAAA", folded, childMd));
    expect(pointers(r.entry.detail)).toBe(1);
    expect(r.entry.historyChild).toBe(CHILD);
    expect(r.entry.detail).not.toContain("older line"); // still only in the child
  });
});
