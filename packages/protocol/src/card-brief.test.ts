import { describe, expect, it } from "vitest";
import { CardSchema } from "./schemas.js";

const field = { id: "q1", kind: "free-text", label: "Why?" };

describe("card shape", () => {
  it("rejects a card with no fields", () => {
    expect(CardSchema.safeParse({ tool: "ask", fields: [] }).success).toBe(false);
  });
  it("accepts an option href only as a same-origin path", () => {
    const card = (href?: string) => ({ tool: "t", fields: [{ id: "m", kind: "multi", label: "Pick", options: [{ label: "A", value: "a", ...(href === undefined ? {} : { href }) }] }] });
    expect(CardSchema.safeParse(card("/work/w1?view=graduation")).success).toBe(true);
    expect(CardSchema.safeParse(card()).success).toBe(true);
    for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "/ok\tbad", "/ok\nbad", "/ok bad", "javascript:alert(1)", "work/w1"]) expect(CardSchema.safeParse(card(bad)).success, bad).toBe(false);
  });
  it("parses a legacy acknowledge-only card: no fields but a brief header", () => {
    const r = CardSchema.safeParse({ tool: "brief", fields: [], brief: { headline: "FYI" } });
    expect(r.success).toBe(true);
  });
  it("still parses a legacy card carrying a brief header (old transcripts)", () => {
    const r = CardSchema.safeParse({ tool: "brief", fields: [field], brief: { headline: "Ship it?", context: ["a"] } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.brief?.headline).toBe("Ship it?");
  });
});
