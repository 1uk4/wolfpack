import { describe, expect, it } from "vitest";
import { ThreadMessageSchema } from "./schemas.js";

const base = { id: "entry-1", role: "assistant" as const, text: "", at: "2026-10-29T00:00:00.000Z" };
describe("ThreadMessage.compaction", () => {
  it("accepts a marker with summary and optional reason; stays optional for older servers", () => {
    expect(ThreadMessageSchema.parse({ ...base, compaction: { summary: "s", reason: "manual" } }).compaction).toEqual({ summary: "s", reason: "manual" });
    expect(ThreadMessageSchema.parse(base).compaction).toBeUndefined();
    expect(ThreadMessageSchema.safeParse({ ...base, compaction: {} }).success).toBe(false);
  });
});
