import { describe, it, expect } from "vitest";
import { normalizeEntry } from "./normalize.js";
import type { Entry as Entry } from "../schema/knowledge.js";
import { EntryId, DomainId, SectionId, IsoDate } from "../schema/knowledge.js";

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: EntryId.parse("kb-wolfpack-abc1234"),
    domain: DomainId.parse("wolfpack"),
    title: "Test Entry",
    kind: { type: "architecture" },
    summary: "Test summary",
    detail: "Test detail",
    confidence: "high",
    facets: {},
    properties: {},
    section: SectionId.parse("sec-wolfpack-sec001"),
    placement: { basis: "routed", fit: 0.85 },
    relations: [],
    authority: "curated",
    maturity: "active",
    currency: "live",
    verified: false,
    created: IsoDate.parse("2026-01-01"),
    updated: IsoDate.parse("2026-01-02"),
    contentHash: "abc123",
    ...overrides,
  };
}

describe("normalizeEntry", () => {
  it("validates section exists in known sections", () => {
    const entry = makeEntry({
      section: SectionId.parse("sec-wolfpack-miss01"),
    });

    const knownSections = new Set(["sec-wolfpack-sec001", "sec-wolfpack-sec002"]);
    const knownEntries = new Set<string>();

    const { warnings } = normalizeEntry(entry, knownSections, knownEntries);

    expect(warnings).toEqual([
      "section: sec-wolfpack-miss01 not in known sections (orphaned entry)",
    ]);
  });

  it("passes validation when section is known", () => {
    const entry = makeEntry();

    const knownSections = new Set(["sec-wolfpack-sec001"]);
    const knownEntries = new Set<string>();

    const { warnings } = normalizeEntry(entry, knownSections, knownEntries);

    expect(warnings).toEqual([]);
  });

  it("drops relations with unknown targets (referential integrity)", () => {
    const entry = makeEntry({
      relations: [
        {
          kind: "refines",
          target: EntryId.parse("kb-wolfpack-exists1"),
          source: "llm",
        },
        {
          kind: "depends_on",
          target: EntryId.parse("kb-wolfpack-missing"),
          source: "llm",
        },
        {
          kind: "see_also",
          target: EntryId.parse("kb-wolfpack-exists2"),
          source: "embedding",
          weight: 0.92,
        },
      ],
    });

    const knownSections = new Set(["sec-wolfpack-sec001"]);
    const knownEntries = new Set(["kb-wolfpack-exists1", "kb-wolfpack-exists2"]);

    const { entry: normalized, warnings } = normalizeEntry(
      entry,
      knownSections,
      knownEntries
    );

    // Only relations with known targets should remain
    expect(normalized.relations).toHaveLength(2);
    expect(normalized.relations[0].target).toBe("kb-wolfpack-exists1");
    expect(normalized.relations[1].target).toBe("kb-wolfpack-exists2");

    expect(warnings).toEqual([
      "relation: dropped dangling depends_on → kb-wolfpack-missing (no such entry)",
    ]);
  });

  it("drops self-referential relations", () => {
    const entry = makeEntry({
      relations: [
        {
          kind: "refines",
          target: EntryId.parse("kb-wolfpack-abc1234"), // self-reference
          source: "llm",
        },
        {
          kind: "depends_on",
          target: EntryId.parse("kb-wolfpack-other12"),
          source: "llm",
        },
      ],
    });

    const knownSections = new Set(["sec-wolfpack-sec001"]);
    const knownEntries = new Set([
      "kb-wolfpack-abc1234",
      "kb-wolfpack-other12",
    ]);

    const { entry: normalized, warnings } = normalizeEntry(
      entry,
      knownSections,
      knownEntries
    );

    // Self-reference should be dropped
    expect(normalized.relations).toHaveLength(1);
    expect(normalized.relations[0].target).toBe("kb-wolfpack-other12");

    expect(warnings).toEqual([
      "relation: dropped self-reference (refines → kb-wolfpack-abc1234)",
    ]);
  });

  it("preserves all valid relations", () => {
    const entry = makeEntry({
      relations: [
        {
          kind: "refines",
          target: EntryId.parse("kb-wolfpack-target1"),
          source: "llm",
        },
        {
          kind: "see_also",
          target: EntryId.parse("kb-wolfpack-target2"),
          source: "embedding",
          weight: 0.88,
        },
        {
          kind: "depends_on",
          target: EntryId.parse("kb-wolfpack-target3"),
          source: "human",
        },
      ],
    });

    const knownSections = new Set(["sec-wolfpack-sec001"]);
    const knownEntries = new Set([
      "kb-wolfpack-abc1234",
      "kb-wolfpack-target1",
      "kb-wolfpack-target2",
      "kb-wolfpack-target3",
    ]);

    const { entry: normalized, warnings } = normalizeEntry(
      entry,
      knownSections,
      knownEntries
    );

    // All relations should be preserved
    expect(normalized.relations).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  it("handles entries with no relations", () => {
    const entry = makeEntry({ relations: [] });

    const knownSections = new Set(["sec-wolfpack-sec001"]);
    const knownEntries = new Set<string>();

    const { entry: normalized, warnings } = normalizeEntry(
      entry,
      knownSections,
      knownEntries
    );

    expect(normalized.relations).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
