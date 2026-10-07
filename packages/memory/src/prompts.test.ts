/**
 * Tests for prompt builders with digest priming.
 */
import { describe, it, expect } from "vitest";
import { buildConsolidatePrompt } from "./prompts.js";
import type { TopicFile } from "./session/memory.js";
import type { DenTopic } from "./den.js";
import type { ContextDigest, DigestSection } from "@wolfpack/kb/shared";

describe("buildConsolidatePrompt", () => {
  const sessionTopics: TopicFile[] = [
    {
      id: "topic-1",
      title: "Test Topic",
      summary: "A test topic",
      updated: "2024-01-01T00:00:00Z",
      body: "Test body content",
      filename: "topic-1.md",
    },
  ];

  const denTopics: DenTopic[] = [
    {
      id: "den-1",
      title: "Existing Topic",
      summary: "An existing topic",
      updated: "2024-01-01T00:00:00Z",
      related: [],
      body: "Existing body content",
      filePath: "/path/to/den-1.md",
    },
  ];

  it("should build prompt without digest", () => {
    const prompt = buildConsolidatePrompt(sessionTopics, denTopics);
    
    expect(prompt).toContain("SESSION TOPICS");
    expect(prompt).toContain("DEN TOPICS");
    expect(prompt).not.toContain("PACK ALREADY KNOWS");
    expect(prompt).toContain("topic-1");
    expect(prompt).toContain("den-1");
  });

  it("should include PACK ALREADY KNOWS block when digest is provided", () => {
    const sections: DigestSection[] = [
      {
        sectionId: "kb-section-1",
        title: "KB Topic 1",
        summary: "Summary of KB topic 1",
        currency: "live",
        entryIds: ["entry-1"],
        children: [],
      },
      {
        sectionId: "kb-section-2",
        title: "KB Topic 2",
        summary: "Summary of KB topic 2",
        currency: "snapshot",
        entryIds: ["entry-2"],
        children: [],
      },
    ];

    const prompt = buildConsolidatePrompt(sessionTopics, denTopics, sections);
    
    expect(prompt).toContain("SESSION TOPICS");
    expect(prompt).toContain("DEN TOPICS");
    expect(prompt).toContain("PACK ALREADY KNOWS");
    expect(prompt).toContain("kb-section-1");
    expect(prompt).toContain("KB Topic 1");
    expect(prompt).toContain("Summary of KB topic 1");
    expect(prompt).toContain("kb-section-2");
  });

  it("should accept full ContextDigest and extract sections", () => {
    const digest: ContextDigest = {
      domain: "test-domain",
      generated: "2024-01-01T00:00:00Z",
      vocabulary: {
        kinds: ["note"],
        facetKeys: [],
        relationKinds: [],
      },
      sections: [
        {
          sectionId: "kb-section-1",
          title: "KB Topic 1",
          summary: "Summary of KB topic 1",
          currency: "live",
          entryIds: ["entry-1"],
          children: [],
        },
      ],
      gaps: [],
    };

    const prompt = buildConsolidatePrompt(sessionTopics, denTopics, digest);
    
    expect(prompt).toContain("PACK ALREADY KNOWS");
    expect(prompt).toContain("kb-section-1");
    expect(prompt).toContain("KB Topic 1");
  });

  it("should respect maxPrimedTopics cap (8 topics)", () => {
    const sections: DigestSection[] = Array.from({ length: 20 }, (_, i) => ({
      sectionId: `kb-section-${i}`,
      title: `KB Topic ${i}`,
      summary: `Summary ${i}`,
      currency: "live" as const,
      entryIds: [`entry-${i}`],
      children: [],
    }));

    const prompt = buildConsolidatePrompt(sessionTopics, denTopics, sections);
    
    // Should include first 8 sections (maxPrimedTopics = 8)
    expect(prompt).toContain("kb-section-0");
    expect(prompt).toContain("kb-section-7");
    
    // Should NOT include section 8 and beyond
    expect(prompt).not.toContain("kb-section-8");
    expect(prompt).not.toContain("kb-section-19");
  });

  it("should not add PACK ALREADY KNOWS block when digest has no sections", () => {
    const prompt = buildConsolidatePrompt(sessionTopics, denTopics, []);
    
    expect(prompt).toContain("SESSION TOPICS");
    expect(prompt).toContain("DEN TOPICS");
    expect(prompt).not.toContain("PACK ALREADY KNOWS");
  });
});
