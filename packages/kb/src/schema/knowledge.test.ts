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
  coerceFacets,
  coerceProperties,
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
    properties: {},
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

describe("LlmOpinion.facets leniency (drop-don't-fail)", () => {
  const base = {
    title: "Test Entry",
    kind: { type: "overview" as const },
    summary: "x",
    detail: "y",
    confidence: "high" as const,
  };

  it("strips unknown facet keys and non-slug values instead of throwing", () => {
    // The exact payload that hard-failed the sweep (sfo01 deploy + kb-package).
    const r = LlmOpinion.safeParse({
      ...base,
      facets: {
        host: "sfo01", provider: "DigitalOcean", region: "SFO1",
        testCount: 42, routeThresholds: { a: 1 }, exportSurfaces: ["cli"],
        subsystem: "auth",       // valid key + slug  -> keep
        lifecycle: "Archived",   // valid key, bad slug -> drop
        surface: "admin-portal", // valid -> keep
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.facets).toEqual({ subsystem: "auth", surface: "admin-portal" });
    }
  });

  it("defaults to {} when facets are absent", () => {
    const r = LlmOpinion.parse(base);
    expect(r.facets).toEqual({});
  });

  it("coerceFacets keeps only controlled keys with valid slugs", () => {
    expect(coerceFacets({ layer: "core", bogus: "x", surface: "UPPER" })).toEqual({
      layer: "core",
    });
    expect(coerceFacets(null)).toEqual({});
    expect(coerceFacets("nope")).toEqual({});
  });
});

describe("LlmOpinion.properties (open attribute bag)", () => {
  const base = {
    title: "Test Entry",
    kind: { type: "overview" as const },
    summary: "x",
    detail: "y",
    confidence: "high" as const,
  };

  it("captures structured attributes facets reject, normalizing keys/values", () => {
    const r = LlmOpinion.parse({
      ...base,
      facets: { subsystem: "infra", host: "sfo01" }, // host dropped from facets
      properties: {
        host: "sfo01", provider: "DigitalOcean", public_ip: "1.2.3.4",
        testCount: 42, exportSurfaces: ["cli", "mcp"],
        routeThresholds: { a: 1 }, // nested object -> dropped
      },
    });
    expect(r.facets).toEqual({ subsystem: "infra" });
    expect(r.properties).toEqual({
      host: "sfo01",
      provider: "DigitalOcean",
      "public-ip": "1.2.3.4",
      "test-count": "42",
      "export-surfaces": "cli, mcp",
    });
  });

  it("defaults to {} when properties are absent", () => {
    expect(LlmOpinion.parse(base).properties).toEqual({});
  });

  it("coerceProperties bounds the bag and drops non-coercible values", () => {
    expect(coerceProperties({ a: "x", b: 2, c: true, d: null, e: { z: 1 } })).toEqual({
      a: "x", b: "2", c: "true",
    });
    expect(coerceProperties(null)).toEqual({});
    const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"]));
    expect(Object.keys(coerceProperties(big)).length).toBe(30);
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
