import { describe, expect, it } from "vitest";
import { pageRange } from "./paging.js";
import type { ThreadMessage } from "./schemas.js";

const msgs = (n: number, tools: Record<number, string> = {}): ThreadMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? "assistant" : "user",
    text: `t${i}`,
    at: "2026-10-29T00:00:00Z",
    ...(tools[i] ? { tools: [{ callId: tools[i]!, name: "ask", args: {} }] } : {}),
  }));

describe("pageRange", () => {
  it("no limit = everything, no paging fields", () => {
    expect(pageRange(msgs(120), {})).toEqual({ start: 0, end: 120, hasMore: false });
  });
  it("newest page is the last `limit`; cursor is its first id", () => {
    expect(pageRange(msgs(120), { limit: 50 })).toEqual({ start: 70, end: 120, hasMore: true, cursor: "m70" });
  });
  it("everything since the newest compaction wins when larger", () => {
    expect(pageRange(msgs(120), { limit: 50, compactionIndex: 20 })).toMatchObject({ start: 20, hasMore: true });
    expect(pageRange(msgs(120), { limit: 50, compactionIndex: 100 })).toMatchObject({ start: 70 });
  });
  it("widens to hold a pending card's message", () => {
    expect(pageRange(msgs(120, { 10: "c1" }), { limit: 50, requiredCallIds: ["c1"] })).toMatchObject({ start: 10 });
  });
  it("before: exactly the limit older messages; unknown cursor is empty", () => {
    expect(pageRange(msgs(120), { limit: 50, before: "m70" })).toEqual({ start: 20, end: 70, hasMore: true, cursor: "m20" });
    expect(pageRange(msgs(120), { limit: 50, before: "m30" })).toEqual({ start: 0, end: 30, hasMore: false, cursor: "m0" });
    expect(pageRange(msgs(120), { limit: 50, before: "nope" })).toEqual({ start: 0, end: 0, hasMore: false });
  });
});
