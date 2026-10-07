/**
 * Tests for crawl consolidation with running digest support.
 */
import { describe, it, expect } from "vitest";
import { mergeRunningDigest, buildCrawlConsolidatePrompt } from "./consolidate.js";
import type { ContextDigest, DigestSection } from "@wolfpack/kb/shared";
import type { CrawlObservation } from "./extract.js";

describe("mergeRunningDigest", () => {
  it("should merge published and produced sections", () => {
    const published: ContextDigest = {
      domain: "test-domain",
      generated: "2024-01-01T00:00:00Z",
      vocabulary: {
        kinds: ["note"],
        facetKeys: [],
        relationKinds: [],
      },
      sections: [
        {
          sectionId: "pub-1",
          title: "Published Topic 1",
          summary: "Old summary",
          currency: "live",
          entryIds: ["entry-1"],
          children: [],
        },
        {
          sectionId: "pub-2",
          title: "Published Topic 2",
          summary: "Summary 2",
          currency: "snapshot",
          entryIds: ["entry-2"],
          children: [],
        },
      ],
      gaps: [],
    };

    const produced: DigestSection[] = [
      {
        sectionId: "prod-1",
        title: "Produced Topic 1",
        summary: "New summary",
        currency: "live",
        entryIds: ["entry-3"],
        children: [],
      },
    ];

    const result = mergeRunningDigest(published, produced);

    expect(result.domain).toBe("test-domain");
    expect(result.sections).toHaveLength(3);
    
    // Produced sections should come first
    expect(result.sections[0].sectionId).toBe("prod-1");
    
    // Published sections that don't overlap should be included
    expect(result.sections.some(s => s.sectionId === "pub-1")).toBe(true);
    expect(result.sections.some(s => s.sectionId === "pub-2")).toBe(true);
  });

  it("should give precedence to produced sections (produced wins)", () => {
    const published: ContextDigest = {
      domain: "test-domain",
      generated: "2024-01-01T00:00:00Z",
      vocabulary: {
        kinds: ["note"],
        facetKeys: [],
        relationKinds: [],
      },
      sections: [
        {
          sectionId: "same-id",
          title: "Old Title",
          summary: "Old summary",
          currency: "snapshot",
          entryIds: ["entry-1"],
          children: [],
        },
      ],
      gaps: [],
    };

    const produced: DigestSection[] = [
      {
        sectionId: "same-id",
        title: "New Title",
        summary: "Fresh summary",
        currency: "live",
        entryIds: ["entry-1"],
        children: [],
      },
    ];

    const result = mergeRunningDigest(published, produced);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].title).toBe("New Title");
    expect(result.sections[0].summary).toBe("Fresh summary");
    expect(result.sections[0].currency).toBe("live");
  });

  it("should handle hierarchical sections by flattening", () => {
    const published: ContextDigest = {
      domain: "test-domain",
      generated: "2024-01-01T00:00:00Z",
      vocabulary: {
        kinds: ["note"],
        facetKeys: [],
        relationKinds: [],
      },
      sections: [
        {
          sectionId: "parent",
          title: "Parent",
          summary: "Parent summary",
          currency: "live",
          entryIds: ["entry-1"],
          children: [
            {
              sectionId: "child",
              title: "Child",
              summary: "Child summary",
              currency: "live",
              entryIds: ["entry-2"],
              children: [],
            },
          ],
        },
      ],
      gaps: [],
    };

    const produced: DigestSection[] = [];

    const result = mergeRunningDigest(published, produced);

    // Both parent and child should be in the flattened result
    expect(result.sections.some(s => s.sectionId === "parent")).toBe(true);
    expect(result.sections.some(s => s.sectionId === "child")).toBe(true);
  });

  it("should avoid duplicates when entries overlap", () => {
    const published: ContextDigest = {
      domain: "test-domain",
      generated: "2024-01-01T00:00:00Z",
      vocabulary: {
        kinds: ["note"],
        facetKeys: [],
        relationKinds: [],
      },
      sections: [
        {
          sectionId: "pub-1",
          title: "Published",
          summary: "Summary",
          currency: "live",
          entryIds: ["shared-entry"],
          children: [],
        },
      ],
      gaps: [],
    };

    const produced: DigestSection[] = [
      {
        sectionId: "prod-1",
        title: "Produced",
        summary: "Summary",
        currency: "live",
        entryIds: ["shared-entry"],
        children: [],
      },
    ];

    const result = mergeRunningDigest(published, produced);

    // Should only have the produced section since it overlaps by entryId
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].sectionId).toBe("prod-1");
  });
});

describe("buildCrawlConsolidatePrompt", () => {
  const observations: CrawlObservation[] = [
    {
      batch: "test-batch",
      relPath: "test/file1.md",
      sourceDate: "2024-01-01",
      timestamp: "2024-01-01",
      content: "Observation 1",
    },
    {
      batch: "test-batch",
      relPath: "test/file2.md",
      sourceDate: "",
      timestamp: "",
      content: "Undated observation",
    },
  ];

  it("should build prompt without digest", () => {
    const prompt = buildCrawlConsolidatePrompt(
      "test-topic",
      "snapshot",
      observations
    );

    expect(prompt).toContain("TOPIC: test-topic");
    expect(prompt).toContain("CURRENCY: snapshot");
    expect(prompt).toContain("OBSERVATIONS");
    expect(prompt).toContain("2024-01-01  Observation 1");
    expect(prompt).toContain("undated  Undated observation");
    expect(prompt).not.toContain("PACK ALREADY KNOWS");
  });

  it("should include PACK ALREADY KNOWS block when digest is provided", () => {
    const digest: DigestSection[] = [
      {
        sectionId: "kb-1",
        title: "KB Topic",
        summary: "KB summary",
        currency: "live",
        entryIds: ["entry-1"],
        children: [],
      },
    ];

    const prompt = buildCrawlConsolidatePrompt(
      "test-topic",
      "snapshot",
      observations,
      undefined,
      digest
    );

    expect(prompt).toContain("PACK ALREADY KNOWS");
    expect(prompt).toContain("kb-1");
    expect(prompt).toContain("KB Topic");
    expect(prompt).toContain("KB summary");
  });

  it("should include existing entry when provided", () => {
    const existing = "# Existing Entry\nSome existing content";

    const prompt = buildCrawlConsolidatePrompt(
      "test-topic",
      "snapshot",
      observations,
      existing
    );

    expect(prompt).toContain("EXISTING ENTRY");
    expect(prompt).toContain("Existing Entry");
    expect(prompt).toContain("Some existing content");
  });

  it("should accept RunningDigest and extract sections", () => {
    const runningDigest: ContextDigest = {
      domain: "test-domain",
      generated: "2024-01-01T00:00:00Z",
      vocabulary: {
        kinds: ["note"],
        facetKeys: [],
        relationKinds: [],
      },
      sections: [
        {
          sectionId: "kb-1",
          title: "KB Topic",
          summary: "KB summary",
          currency: "live",
          entryIds: ["entry-1"],
          children: [],
        },
      ],
      gaps: [],
    };

    const prompt = buildCrawlConsolidatePrompt(
      "test-topic",
      "snapshot",
      observations,
      undefined,
      runningDigest
    );

    expect(prompt).toContain("PACK ALREADY KNOWS");
    expect(prompt).toContain("kb-1");
  });

  it("should respect maxPrimedTopics cap", () => {
    const sections: DigestSection[] = Array.from({ length: 20 }, (_, i) => ({
      sectionId: `kb-${i}`,
      title: `Topic ${i}`,
      summary: `Summary ${i}`,
      currency: "live" as const,
      entryIds: [`entry-${i}`],
      children: [],
    }));

    const prompt = buildCrawlConsolidatePrompt(
      "test-topic",
      "snapshot",
      observations,
      undefined,
      sections
    );

    // Should include first 8 sections
    expect(prompt).toContain("kb-0");
    expect(prompt).toContain("kb-7");
    
    // Should NOT include section 8 and beyond
    expect(prompt).not.toContain("kb-8");
    expect(prompt).not.toContain("kb-19");
  });

  it("should not add PACK ALREADY KNOWS block when digest is empty", () => {
    const prompt = buildCrawlConsolidatePrompt(
      "test-topic",
      "snapshot",
      observations,
      undefined,
      []
    );

    expect(prompt).not.toContain("PACK ALREADY KNOWS");
  });
});
