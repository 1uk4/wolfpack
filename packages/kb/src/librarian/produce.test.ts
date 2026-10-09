import { describe, it, expect, vi } from "vitest";
import { produceEntry, type ProduceEntryInput } from "./produce.js";
import type { Engine } from "@wolfpack/engine";
import type { ParsedContribution } from "../shared/index.js";
import {
  type LlmOpinion,
  type RelationResolver,
  SectionId,
  EntryId,
  DomainId,
  type RelationKind,
} from "../schema/knowledge.js";

// Mock engine that returns a valid LlmOpinion
function mockEngine(opinion: Partial<LlmOpinion> = {}): Engine {
  const defaultOpinion: LlmOpinion = {
    title: "Test Entry",
    kind: { type: "architecture" },
    summary: "Test summary",
    detail: "Test detail content",
    confidence: "high",
    facets: {},
    proposedRelations: [],
    ...opinion,
  };

  return {
    call: vi.fn().mockResolvedValue(defaultOpinion),
  } as unknown as Engine;
}

function mockContribution(overrides: Partial<ParsedContribution> = {}): ParsedContribution {
  return {
    from: "test-wolf",
    denTopicId: "topic-test123",
    summary: "Test contribution summary",
    body: "Test contribution body",
    contentHash: "abc123",
    filePath: "/tmp/test.md",
    currency: "live",
    ...overrides,
  } as ParsedContribution;
}

describe("produceEntry", () => {
  it("produces a create entry with deterministic DerivedFacts", async () => {
    const engine = mockEngine();
    const contribution = mockContribution();
    const resolve: RelationResolver = () => null;

    const result = await produceEntry(engine, {
      contribution,
      domain: "wolfpack",
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      resolve,
    });

    expect(result.action).toBe("create");
    expect(result.entry.id).toMatch(/^kb-wolfpack-[0-9A-Za-z]{7}$/);
    expect(result.entry.domain).toBe("wolfpack");
    expect(result.entry.section).toBe("sec-wolfpack-abc123");
    expect(result.entry.placement.basis).toBe("routed");
    expect(result.entry.placement.fit).toBe(0.85);
    expect(result.entry.title).toBe("Test Entry");
  });

  it("produces a merge entry when entryId is provided", async () => {
    const engine = mockEngine();
    const contribution = mockContribution();
    const resolve: RelationResolver = () => null;

    const result = await produceEntry(engine, {
      contribution,
      domain: "wolfpack",
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      entryId: "kb-wolfpack-xyz7890",
      existingMarkdown: "# Existing\nExisting content",
      resolve,
    });

    expect(result.action).toBe("merge");
    expect(result.entry.id).toBe("kb-wolfpack-xyz7890");
  });

  it("FIREWALL: drops unresolved relation hints (no invented ids)", async () => {
    const engine = mockEngine({
      proposedRelations: [
        { kind: "refines", targetHint: "some vague reference to auth system" },
        { kind: "depends_on", targetHint: "another unknown thing" },
      ],
    });
    const contribution = mockContribution();

    // Resolver that always fails (simulates no match found)
    const resolve: RelationResolver = () => null;

    const result = await produceEntry(engine, {
      contribution,
      domain: "wolfpack",
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      resolve,
    });

    // All proposed relations should be dropped (not resolved)
    expect(result.entry.relations).toEqual([]);
  });

  it("FIREWALL: resolves valid relation hints to real EntryIds", async () => {
    const targetId = EntryId.parse("kb-wolfpack-target1");

    const engine = mockEngine({
      proposedRelations: [
        { kind: "refines", targetHint: "authentication system" },
        { kind: "depends_on", targetHint: "config module" },
      ],
    });
    const contribution = mockContribution();

    // Resolver that returns a real entry id for the first hint, fails on second
    const resolve: RelationResolver = (hint: string, kind: RelationKind) => {
      if (hint === "authentication system") {
        return { target: targetId, weight: 0.92 };
      }
      return null;
    };

    const result = await produceEntry(engine, {
      contribution,
      domain: "wolfpack",
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      resolve,
    });

    // Only the resolved relation should be present
    expect(result.entry.relations).toHaveLength(1);
    expect(result.entry.relations[0].kind).toBe("refines");
    expect(result.entry.relations[0].target).toBe(targetId);
    expect(result.entry.relations[0].source).toBe("llm");
    expect(result.entry.relations[0].weight).toBe(0.92);
  });

  it("stamps section + placement from params, NOT from model", async () => {
    // Even if the model somehow tried to emit section data (which it can't in
    // LlmOpinion schema), the section/placement come from the router params
    const engine = mockEngine();
    const contribution = mockContribution();
    const resolve: RelationResolver = () => null;

    const section = SectionId.parse("sec-wolfpack-route9");
    const placement = { basis: "crystallized" as const, fit: 0.95 };

    const result = await produceEntry(engine, {
      contribution,
      domain: "wolfpack",
      section,
      placement,
      resolve,
    });

    expect(result.entry.section).toBe(section);
    expect(result.entry.placement.basis).toBe("crystallized");
    expect(result.entry.placement.fit).toBe(0.95);
  });

  it("applies curator overrides when provided", async () => {
    const engine = mockEngine();
    const contribution = mockContribution();
    const resolve: RelationResolver = () => null;

    const pinnedSection = SectionId.parse("sec-wolfpack-pinned");

    const result = await produceEntry(engine, {
      contribution,
      domain: "wolfpack",
      section: SectionId.parse("sec-wolfpack-routed"),
      placement: { basis: "routed", fit: 0.85 },
      resolve,
      overrides: {
        authority: "curated",
        maturity: "canonical",
        verified: true,
        pinnedSection,
      },
    });

    // Curator overrides should win
    expect(result.entry.maturity).toBe("canonical");
    expect(result.entry.verified).toBe(true);
    expect(result.entry.section).toBe(pinnedSection);
    expect(result.entry.placement.basis).toBe("curator-pinned");
  });

  it("preserves temporal provenance (asOf) from contribution", async () => {
    const engine = mockEngine();
    const contribution = mockContribution({
      sourceUpdated: "2025-06-15",
    });
    const resolve: RelationResolver = () => null;

    const result = await produceEntry(engine, {
      contribution,
      domain: "wolfpack",
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      resolve,
    });

    expect(result.entry.asOf).toBe("2025-06-15");
  });

  it("sets currency to archived when contribution is archived", async () => {
    const engine = mockEngine();
    const contribution = mockContribution({
      currency: "archived",
    });
    const resolve: RelationResolver = () => null;

    const result = await produceEntry(engine, {
      contribution,
      domain: "wolfpack",
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      resolve,
    });

    expect(result.entry.currency).toBe("archived");
  });
});

describe("LlmOpinion schema enforcement (firewall test)", () => {
  it("rejects malformed LlmOpinion (schema validation)", async () => {
    // Simulate an engine that returns malformed data
    const badEngine = {
      call: vi.fn().mockResolvedValue({
        title: "T",
        kind: { type: "architecture" },
        summary: "S",
        detail: "D",
        // Missing required 'confidence' field
      }),
    } as unknown as Engine;

    const contribution = mockContribution();
    const resolve: RelationResolver = () => null;

    // The LlmOpinion schema should reject this
    await expect(
      produceEntry(badEngine, {
        contribution,
        domain: "wolfpack",
        section: SectionId.parse("sec-wolfpack-abc123"),
        placement: { basis: "routed", fit: 0.85 },
        resolve,
      })
    ).rejects.toThrow();
  });
});
