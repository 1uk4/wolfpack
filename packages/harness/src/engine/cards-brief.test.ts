import { describe, expect, it } from "vitest";
import { BRIEF_LIMITS, CardSchema } from "@wolfpack/protocol";
import { briefHeader, clipText, confirmCard } from "./cards.js";

describe("briefHeader / confirmCard brief", () => {
  it("clips a long headline to the hard limit with an ellipsis", () => {
    const h = briefHeader(`Ship "${"x".repeat(300)}"?`);
    expect(h.headline.length).toBe(BRIEF_LIMITS.headline);
    expect(h.headline.endsWith("…")).toBe(true);
  });
  it("caps bullets at 5, clips them to the soft length, drops empties", () => {
    const h = briefHeader("h", ["a".repeat(500), "", "b", "c", "d", "e", "f"]);
    expect(h.context).toHaveLength(5);
    expect(h.context![0].length).toBeLessThanOrEqual(BRIEF_LIMITS.bulletSoftChars);
  });
  it("collapses newlines and never returns an empty headline", () => {
    expect(clipText("a\n\n b", 80)).toBe("a b");
    expect(briefHeader("  ").headline).toBe("Confirm");
  });
  it("confirmCard with a brief keeps the field unchanged and validates", () => {
    const plain = confirmCard({ tool: "t", question: "Q?", confirmLabel: "Y" });
    const withBrief = confirmCard({ tool: "t", question: "Q?", confirmLabel: "Y", brief: briefHeader("H", ["x"]) });
    expect(withBrief.fields).toEqual(plain.fields);
    expect(plain.brief).toBeUndefined();
    expect(CardSchema.safeParse(withBrief).success).toBe(true);
  });
});
