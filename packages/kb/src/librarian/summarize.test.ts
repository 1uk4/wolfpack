import { describe, it, expect, vi } from "vitest";
import { sectionSummary } from "./summarize.js";
import { SectionSummarySchema } from "../shared/index.js";
import type { Engine } from "@wolfpack/engine";

function mockEngine(summaryText = "Consolidated section summary"): Engine {
  // Mirror the real engine.call contract: output is parsed by the given schema.
  return {
    call: vi.fn(async (_step: unknown, schema: { parse: (v: unknown) => unknown }) =>
      schema.parse({ summary: summaryText })
    ),
  } as unknown as Engine;
}

const promptOf = (engine: Engine): string =>
  (engine.call as ReturnType<typeof vi.fn>).mock.calls[0][2].prompt;

describe("sectionSummary", () => {
  it("summarizes from member titles and summaries", async () => {
    const engine = mockEngine("OAuth2 login, JWT validation, and role-based access control");
    const members = [
      { title: "OAuth2 authentication flow", summary: "Authorization-code flow with PKCE" },
      { title: "JWT token validation" },
      { title: "Role-based access control", summary: "Admin, host, and player roles" },
    ];

    const result = await sectionSummary(engine, members);

    expect(result).toBe("OAuth2 login, JWT validation, and role-based access control");
    expect(engine.call).toHaveBeenCalledWith(
      "sectionSummary",
      expect.anything(),
      expect.objectContaining({ system: expect.any(String), prompt: expect.any(String) })
    );
    const prompt = promptOf(engine);
    expect(prompt).toContain("1. OAuth2 authentication flow — Authorization-code flow with PKCE");
    expect(prompt).toContain("2. JWT token validation\n");
    expect(prompt).toContain("at most 140 characters");
  });

  it("caps members to MAX_CHILD_SUMMARIES and each summary to 200 chars", async () => {
    const engine = mockEngine("Summary of many entries");
    const members = Array.from({ length: 20 }, (_, i) => ({
      title: `Entry ${i + 1}`,
      summary: "x".repeat(500),
    }));

    await sectionSummary(engine, members);

    const prompt = promptOf(engine);
    expect(prompt).toContain("Entry 12 ");
    expect(prompt).not.toContain("Entry 13");
    expect(prompt).not.toContain("x".repeat(201));
  });

  it("clips an over-long model summary to 140 chars", async () => {
    const engine = mockEngine("y".repeat(300));
    const result = await sectionSummary(engine, [{ title: "t" }]);
    expect(result).toHaveLength(140);
    expect(result.endsWith("…")).toBe(true);
  });

  it("handles empty members gracefully", async () => {
    const engine = mockEngine("Empty section summary");
    expect(await sectionSummary(engine, [])).toBe("Empty section summary");
  });

  it("rejects malformed schema output", async () => {
    // engine.call validates against the schema it is given, so malformed output
    // rejects (the confinement firewall).
    const badEngine = {
      call: vi.fn(async (_step: unknown, schema: { parse: (v: unknown) => unknown }) =>
        schema.parse({ wrongField: "test" })
      ),
    } as unknown as Engine;

    await expect(sectionSummary(badEngine, [{ title: "test" }])).rejects.toThrow();
  });

  it("schema trims whitespace and passes short summaries through", () => {
    expect(SectionSummarySchema.parse({ summary: "  Glicko-2 ratings  " }).summary).toBe(
      "Glicko-2 ratings"
    );
  });
});
