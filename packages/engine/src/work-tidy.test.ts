import { describe, it, expect } from "vitest";
import { buildWorkTidyPrompt, parseWorkTidyOutput } from "./work-tidy.js";
import { STEP_TIERS } from "./models.js";

describe("parseWorkTidyOutput", () => {
  it("keeps valid lines with their from refs, also inside a fenced block", () => {
    const json = JSON.stringify({ lines: [{ group: "Decisions", text: "Use a TTL map", from: ["l2", "l9"] }] });
    const want = [{ group: "Decisions", text: "Use a TTL map", from: ["l2", "l9"] }];
    expect(parseWorkTidyOutput(json)).toEqual(want);
    expect(parseWorkTidyOutput("```json\n" + json + "\n```")).toEqual(want);
  });

  it("returns nothing for garbage and drops unknown headings and over-long text", () => {
    expect(parseWorkTidyOutput("not json")).toEqual([]);
    expect(parseWorkTidyOutput('{"lines":"x"}')).toEqual([]);
    const mixed = JSON.stringify({ lines: [{ group: "Misc", text: "a", from: [] }, { group: "Changes", text: "x".repeat(241) }, { group: "Findings", text: "ok" }] });
    expect(parseWorkTidyOutput(mixed)).toEqual([{ group: "Findings", text: "ok", from: [] }]);
  });
});

describe("workTidy prompt and tier", () => {
  it("numbers the Record lines l1… under their headings and runs on the smart tier", () => {
    const p = buildWorkTidyPrompt({ title: "Feat", outcomes: ["Shipped cache"], lines: [{ group: "Decisions", text: "a" }, { group: "Changes", text: "b" }] });
    expect(p).toContain("### Decisions\n[l1] a");
    expect(p).toContain("### Changes\n[l2] b");
    expect(STEP_TIERS.workTidy).toBe("smart");
  });
});
