import { describe, it, expect } from "vitest";
import { isSafeSegment } from "./safe-path.js";

describe("isSafeSegment", () => {
  it("accepts split ids <topicId>~<slug> and plain ids", () => {
    expect(isSafeSegment("kb-sweep-performance~sweep-lock")).toBe(true);
    expect(isSafeSegment("work-wolfpack-ggNO3Sv")).toBe(true);
  });
  it("rejects traversal and separators", () => {
    for (const bad of ["..", ".", "../x", "a/b", "a\\b", "a b", "", "~/x"]) expect(isSafeSegment(bad)).toBe(false);
  });
});
