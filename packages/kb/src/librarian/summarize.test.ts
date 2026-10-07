import { describe, it, expect, vi } from "vitest";
import { sectionSummary } from "./summarize.js";
import type { Engine } from "@wolfpack/engine";

function mockEngine(summaryText = "Consolidated section summary"): Engine {
  return {
    call: vi.fn().mockResolvedValue({ summary: summaryText }),
  } as unknown as Engine;
}

describe("sectionSummary", () => {
  it("produces a summary from child summaries", async () => {
    const engine = mockEngine("This section covers authentication and authorization.");
    const childSummaries = [
      "OAuth2 authentication flow",
      "JWT token validation",
      "Role-based access control",
    ];

    const result = await sectionSummary(engine, childSummaries);

    expect(result).toBe("This section covers authentication and authorization.");
    expect(engine.call).toHaveBeenCalledWith(
      "sectionSummary",
      expect.anything(),
      expect.objectContaining({
        system: expect.any(String),
        prompt: expect.stringContaining("OAuth2 authentication flow"),
      })
    );
  });

  it("caps input to MAX_CHILD_SUMMARIES (bounded context)", async () => {
    const engine = mockEngine("Summary of many entries");
    // Provide more than the max (12)
    const childSummaries = Array.from({ length: 20 }, (_, i) => `Entry ${i + 1}`);

    const result = await sectionSummary(engine, childSummaries);

    expect(result).toBe("Summary of many entries");
    
    // Verify the call was made (engine.call is mocked)
    const callArgs = (engine.call as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = callArgs[2].prompt;
    
    // Should only include first 12
    expect(prompt).toContain("Entry 1");
    expect(prompt).toContain("Entry 12");
    expect(prompt).not.toContain("Entry 13");
  });

  it("handles empty child summaries gracefully", async () => {
    const engine = mockEngine("Empty section summary");
    const result = await sectionSummary(engine, []);

    expect(result).toBe("Empty section summary");
  });

  it("rejects malformed schema output", async () => {
    // Engine returns invalid schema (missing 'summary' field). The mock must
    // replicate the real engine.call contract: it validates against the schema
    // it is given, so malformed output rejects (the confinement firewall).
    const badEngine = {
      call: vi.fn(async (_step: unknown, schema: { parse: (v: unknown) => unknown }) =>
        schema.parse({ wrongField: "test" })
      ),
    } as unknown as Engine;

    await expect(sectionSummary(badEngine, ["test"])).rejects.toThrow();
  });
});
