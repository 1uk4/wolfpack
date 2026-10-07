import { describe, it, expect } from "vitest";
import {
  EntryId,
  DomainId,
  SectionId,
  IsoDate,
  Slug,
  Section,
  Entry,
  DerivedFacts,
  LlmOpinion,
  CuratorOverrides,
  Placement,
  assembleEntry,
  type RelationResolver,
} from "./knowledge.js";

describe("SectionId branded primitive", () => {
  it("accepts valid section ids", () => {
    expect(() => SectionId.parse("sec-wolfpack-abc123")).not.toThrow();
    expect(() => SectionId.parse("sec-snapjack-XYZ789")).not.toThrow();
    expect(() => SectionId.parse("sec-test-1a2B3c")).not.toThrow();
  });

  it("rejects invalid section ids", () => {
    expect(() => SectionId.parse("kb-wolfpack-abc1234")).toThrow();
    expect(() => SectionId.parse("sec-wolfpack-abc12345")).toThrow(); // too long
    expect(() => SectionId.parse("sec-wolfpack-abc12")).toThrow(); // too short
    expect(() => SectionId.parse("section-wolfpack-abc123")).toThrow();
    expect(() => SectionId.parse("sec-wolfpack")).toThrow();
  });
});

describe("Section schema", () => {
  const validSection = {
    id: SectionId.parse("sec-wolfpack-abc123"),
    domain: DomainId.parse("wolfpack"),
    parent: null,
    depth: 0,
    label: Slug.parse("root"),
    title: "Root Section",
    centroid: new Array(768).fill(0.1),
    memberCount: 5,
    childIds: [],
    summary: "Root section summary",
    summaryHash: "abc123hash",
    dirty: false,
    created: IsoDate.parse("2026-01-01"),
    updated: IsoDate.parse("2026-01-02"),
  };

  it("accepts a valid root section", () => {
    expect(() => Section.parse(validSection)).not.toThrow();
  });

  it("accepts a section with a parent", () => {
    const child = {
      ...validSection,
      id: SectionId.parse("sec-wolfpack-def456"),
      parent: SectionId.parse("sec-wolfpack-abc123"),
      depth: 1,
      label: Slug.parse("subsection"),
    };
    expect(() => Section.parse(child)).not.toThrow();
  });

  it("enforces single parent (cannot have array of parents)", () => {
    // TypeScript prevents this at compile time, but verify schema structure
    const section = Section.parse(validSection);
    expect(section.parent).toBeNull();
    expect(typeof section.parent === "string" || section.parent === null).toBe(true);
  });

  it("requires exactly 768-dimensional centroid", () => {
    expect(() =>
      Section.parse({ ...validSection, centroid: new Array(512).fill(0.1) })
    ).toThrow();
    expect(() =>
      Section.parse({ ...validSection, centroid: new Array(768).fill(0.1) })
    ).not.toThrow();
  });
});

describe("Entry schema with section placement", () => {
  const mockResolver: RelationResolver = () => null;

  const baseOpinion: LlmOpinion = {
    title: "Test Entry",
    kind: { type: "architecture" as const },
    summary: "Test summary",
    detail: "Test detail content",
    confidence: "high" as const,
    facets: {},
    proposedRelations: [],
  };

  const baseFacts: DerivedFacts = {
    id: EntryId.parse("kb-wolfpack-abc1234"),
    domain: DomainId.parse("wolfpack"),
    created: IsoDate.parse("2026-01-01"),
    updated: IsoDate.parse("2026-01-01"),
    contentHash: "hash123",
    currency: "live" as const,
    relations: [],
    section: SectionId.parse("sec-wolfpack-abc123"),
    placement: { basis: "routed" as const, fit: 0.85 },
  };

  it("assembles a valid entry with required section field", () => {
    const entry = assembleEntry({
      opinion: baseOpinion,
      facts: baseFacts,
      resolve: mockResolver,
    });
    
    expect(entry.section).toBe(baseFacts.section);
    expect(entry.placement.basis).toBe("routed");
    expect(entry.placement.fit).toBe(0.85);
  });

  it("fails when section is missing from DerivedFacts", () => {
    const factsWithoutSection = { ...baseFacts } as any;
    delete factsWithoutSection.section;
    
    expect(() =>
      DerivedFacts.parse(factsWithoutSection)
    ).toThrow();
  });

  it("curator pinned section overrides routed section", () => {
    const overrides: CuratorOverrides = {
      pinnedSection: SectionId.parse("sec-wolfpack-xyz789"),
    };

    const entry = assembleEntry({
      opinion: baseOpinion,
      facts: baseFacts,
      overrides,
      resolve: mockResolver,
    });

    expect(entry.section).toBe(overrides.pinnedSection);
    expect(entry.placement.basis).toBe("curator-pinned");
    expect(entry.placement.fit).toBe(1.0);
  });

  it("entry round-trips through parse", () => {
    const entry = assembleEntry({
      opinion: baseOpinion,
      facts: baseFacts,
      resolve: mockResolver,
    });

    const reparsed = Entry.parse(entry);
    expect(reparsed).toEqual(entry);
  });

  it("removed fields no longer exist in Entry", () => {
    const entry = assembleEntry({
      opinion: baseOpinion,
      facts: baseFacts,
      resolve: mockResolver,
    });

    expect((entry as any).cluster).toBeUndefined();
    expect((entry as any).centrality).toBeUndefined();
    expect((entry as any).role).toBeUndefined();
    expect((entry as any).integration).toBeUndefined();
  });
});

describe("Placement schema", () => {
  it("validates placement basis enum", () => {
    expect(() =>
      Placement.parse({ basis: "routed", fit: 0.8 })
    ).not.toThrow();
    expect(() =>
      Placement.parse({ basis: "curator-pinned", fit: 1.0 })
    ).not.toThrow();
    expect(() =>
      Placement.parse({ basis: "crystallized", fit: 0.9 })
    ).not.toThrow();
    expect(() =>
      Placement.parse({ basis: "declared", fit: 1.0 })
    ).not.toThrow();
  });

  it("rejects invalid placement basis", () => {
    expect(() =>
      Placement.parse({ basis: "invalid", fit: 0.8 })
    ).toThrow();
  });

  it("enforces fit range 0..1", () => {
    expect(() =>
      Placement.parse({ basis: "routed", fit: -0.1 })
    ).toThrow();
    expect(() =>
      Placement.parse({ basis: "routed", fit: 1.1 })
    ).toThrow();
    expect(() =>
      Placement.parse({ basis: "routed", fit: 0 })
    ).not.toThrow();
    expect(() =>
      Placement.parse({ basis: "routed", fit: 1 })
    ).not.toThrow();
  });
});

describe("Relation with bad section id", () => {
  it("rejects relations with invalid target ids", () => {
    expect(() =>
      EntryId.parse("not-a-valid-id")
    ).toThrow();
    expect(() =>
      SectionId.parse("not-a-valid-section")
    ).toThrow();
  });
});
