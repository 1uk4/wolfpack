/**
 * oracles.test.ts — Tests for the oracle LLM calls with confinement validation.
 */
import { describe, it, expect, vi } from "vitest";
import { createOracles } from "./oracles.js";
import type { Engine } from "@wolfpack/engine";
import type { SectionPick } from "../shared/index.js";

/**
 * Create a mock Engine for testing.
 */
// mockCall is intentionally `any`: vi.fn with a concrete return type is not
// assignable to engine.call's generic <T> signature.
function createMockEngine(mockCall: any): Engine {
  return {
    call: mockCall,
    adapter: {} as any,
    usage: {} as any,
    config: {} as any,
  };
}

describe("oracles — classifyToSection", () => {
  it("returns valid section id when model picks from provided set", async () => {
    const mockEngine = createMockEngine(
      vi.fn(async (_step, _schema, _options) => ({
        section: "sec-123",
        confidence: "high" as const,
      }))
    );

    const oracles = createOracles(mockEngine);
    const sections = [
      { sectionId: "sec-123", title: "Test Section", summary: "A test section" },
      { sectionId: "sec-456", title: "Another Section", summary: "Another test" },
    ];

    const result = await oracles.classifyToSection("Some contribution text", sections);

    expect(result.section).toBe("sec-123");
    expect(result.confidence).toBe("high");
  });

  it("returns NEW when model picks NEW", async () => {
    const mockEngine = createMockEngine(
      vi.fn(async (_step, _schema, _options) => ({
        section: "NEW",
        confidence: "medium" as const,
      }))
    );

    const oracles = createOracles(mockEngine);
    const sections = [
      { sectionId: "sec-123", title: "Test Section", summary: "A test section" },
    ];

    const result = await oracles.classifyToSection("Some contribution text", sections);

    expect(result.section).toBe("NEW");
    expect(result.confidence).toBe("medium");
  });

  it("coerces invalid section id to NEW (firewall test)", async () => {
    // Model returns an id NOT in the provided set — this should be coerced to "NEW"
    const mockEngine = createMockEngine(
      vi.fn(async (_step, _schema, _options) => ({
        section: "sec-999-INVALID",
        confidence: "low" as const,
      }))
    );

    const oracles = createOracles(mockEngine);
    const sections = [
      { sectionId: "sec-123", title: "Test Section", summary: "A test section" },
      { sectionId: "sec-456", title: "Another Section", summary: "Another test" },
    ];

    const result = await oracles.classifyToSection("Some contribution text", sections);

    // FIREWALL: invalid id should be coerced to "NEW"
    expect(result.section).toBe("NEW");
    expect(result.confidence).toBe("low");
  });

  it("builds correct prompt with section enumeration", async () => {
    const mockCall = vi.fn(async (_step, _schema, _options) => ({
      section: "sec-123",
      confidence: "high" as const,
    }));

    const mockEngine = createMockEngine(mockCall);
    const oracles = createOracles(mockEngine);

    const sections = [
      { sectionId: "sec-123", title: "Test Section", summary: "A test section" },
      { sectionId: "sec-456", title: "Another Section", summary: "Another test" },
    ];

    await oracles.classifyToSection("Some contribution text", sections);

    // Verify the prompt was built correctly
    expect(mockCall).toHaveBeenCalledWith(
      "classifyToSection",
      expect.anything(),
      expect.objectContaining({
        prompt: expect.stringContaining("CONTRIBUTION:"),
      })
    );

    const callArgs = mockCall.mock.calls[0];
    const prompt = callArgs[2].prompt;

    expect(prompt).toContain("Some contribution text");
    expect(prompt).toContain("sec-123");
    expect(prompt).toContain("Test Section");
    expect(prompt).toContain("sec-456");
    expect(prompt).toContain("Another Section");
  });

  it("handles empty sections array", async () => {
    const mockEngine = createMockEngine(
      vi.fn(async (_step, _schema, _options) => ({
        section: "NEW",
        confidence: "high" as const,
      }))
    );

    const oracles = createOracles(mockEngine);
    const result = await oracles.classifyToSection("Some contribution text", []);

    // With no sections, only "NEW" is valid
    expect(result.section).toBe("NEW");
  });

  it("preserves all confidence levels through firewall", async () => {
    const confidenceLevels = ["low", "medium", "high"] as const;

    for (const confidence of confidenceLevels) {
      const mockEngine = createMockEngine(
        vi.fn(async (_step, _schema, _options) => ({
          section: "INVALID-ID",
          confidence,
        }))
      );

      const oracles = createOracles(mockEngine);
      const sections = [
        { sectionId: "sec-123", title: "Test", summary: "Test" },
      ];

      const result = await oracles.classifyToSection("text", sections);

      expect(result.section).toBe("NEW");
      expect(result.confidence).toBe(confidence);
    }
  });
});
