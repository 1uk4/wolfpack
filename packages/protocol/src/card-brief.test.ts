import { describe, expect, it } from "vitest";
import { CardSchema } from "./schemas.js";

const field = { id: "q1", kind: "free-text", label: "Why?" };
const parse = (c: unknown) => CardSchema.safeParse(c);

describe("card brief header", () => {
  it("accepts a headline at the limit and rejects one over it", () => {
    expect(parse({ tool: "brief", fields: [field], brief: { headline: "x".repeat(80) } }).success).toBe(true);
    expect(parse({ tool: "brief", fields: [field], brief: { headline: "x".repeat(81) } }).success).toBe(false);
    expect(parse({ tool: "brief", fields: [field], brief: { headline: "" } }).success).toBe(false);
  });
  it("caps context at 5 bullets but not their length", () => {
    const five = ["a", "b", "c", "d", "e"];
    expect(parse({ tool: "brief", fields: [field], brief: { headline: "h", context: five } }).success).toBe(true);
    expect(parse({ tool: "brief", fields: [field], brief: { headline: "h", context: [...five, "f"] } }).success).toBe(false);
    expect(parse({ tool: "brief", fields: [field], brief: { headline: "h", context: ["z".repeat(500)], more: "thread" } }).success).toBe(true);
  });
  it("allows 0 questions on a brief card, at most 3, and requires a field otherwise", () => {
    expect(parse({ tool: "brief", fields: [], brief: { headline: "h" } }).success).toBe(true);
    const four = [1, 2, 3, 4].map((i) => ({ ...field, id: `q${i}` }));
    expect(parse({ tool: "brief", fields: four.slice(0, 3), brief: { headline: "h" } }).success).toBe(true);
    expect(parse({ tool: "brief", fields: four, brief: { headline: "h" } }).success).toBe(false);
    expect(parse({ tool: "ask_user_question", fields: [] }).success).toBe(false);
  });
  it("rejects an unknown-kind field whose showIf is malformed", () => {
    const first = { id: "a", kind: "slider", label: "A" };
    const bad = { id: "b", kind: "slider", label: "B", showIf: { field: "a" } }; // neither equals nor oneOf
    expect(parse({ tool: "brief", fields: [first, bad], brief: { headline: "h" } }).success).toBe(false);
  });
});
