import { describe, expect, it } from "vitest";
import { KB_SYNC_PATH, LinkFrameSchema } from "./index.js";

describe("KB_SYNC_PATH", () => {
  it("accepts the sync grammar", () => {
    for (const p of ["entries/kb-a-1.md", "versions/kb-a-1/2026-01-01.md", "INDEX.md", "_digest.json", "_registry.md"]) expect(KB_SYNC_PATH.test(p)).toBe(true);
  });
  it("rejects dot segments", () => {
    for (const p of ["versions/../INDEX.md", "versions/./x.md", "entries/../x.md", "../INDEX.md", "versions/..//x.md"]) expect(KB_SYNC_PATH.test(p)).toBe(false);
  });
});

describe("grants frame", () => {
  it("parses", () => {
    expect(LinkFrameSchema.safeParse({ t: "grants", domains: ["a"] }).success).toBe(true);
    expect(LinkFrameSchema.safeParse({ t: "welcome", v: 1, heartbeatMs: 1, deadAfterMs: 2 }).success).toBe(true);
  });
});
