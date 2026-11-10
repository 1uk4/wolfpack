import { describe, expect, it } from "vitest";
import { CardSchema } from "./schemas.js";

const field = { id: "q1", kind: "free-text", label: "Why?" };

describe("card shape", () => {
  it("rejects a card with no fields", () => {
    expect(CardSchema.safeParse({ tool: "ask", fields: [] }).success).toBe(false);
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
