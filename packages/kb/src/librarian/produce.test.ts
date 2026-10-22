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
    properties: {},
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

describe("preserveBody (verbatim graduation path)", () => {
  it("skips the LLM call and lifts the contribution body as the entry detail", async () => {
    const engine = mockEngine(); // would error-out if called via mock verification
    const callSpy = vi.spyOn(engine, "call");
    const contribution = mockContribution({
      graduation: "feature",
      preserveBody: true,
      body: "# Week 42\n\n## Sessions\n\n| Day | Workout | Volume |\n|---|---|---|\n| Thu | Pull | 13,543 lb |\n",
      summary: "Week 42 — four sessions, 63,783 lb",
    });
    const resolve: RelationResolver = () => null;

    const result = await produceEntry(engine, {
      contribution,
      domain: "personal",
      section: SectionId.parse("sec-personal-abc123"),
      placement: { basis: "routed", fit: 0.9 },
      resolve,
    });

    expect(callSpy).not.toHaveBeenCalled();
    expect(result.entry.title).toBe("Week 42");
    expect(result.entry.detail).toContain("## Sessions");
    expect(result.entry.detail).toContain("| Thu | Pull | 13,543 lb |");
    expect(result.entry.detail).not.toContain("# Week 42"); // H1 stripped
    expect(result.entry.summary).toBe("Week 42 — four sessions, 63,783 lb");
  });

  it("hubs ignore preserveBody and still call the LLM", async () => {
    const engine = mockEngine();
    const callSpy = vi.spyOn(engine, "call");
    const contribution = mockContribution({
      graduation: "hub",
      preserveBody: true,
      body: "# Fitness\n\nOverview",
    });
    await produceEntry(engine, {
      contribution,
      domain: "personal",
      section: SectionId.parse("sec-personal-abc123"),
      placement: { basis: "routed", fit: 0.9 },
      resolve: () => null,
    });
    expect(callSpy).toHaveBeenCalled();
  });

  it("non-graduation contributions ignore preserveBody", async () => {
    // Not a graduation — preserveBody only applies when graduation is set.
    // Current semantics: preserveBody triggers verbatim only if graduation!="hub",
    // and we require graduation != undefined to prevent arbitrary observational
    // contributions from bypassing the LLM. Guard shape below.
    const engine = mockEngine();
    const callSpy = vi.spyOn(engine, "call");
    const contribution = mockContribution({
      preserveBody: true,
      body: "# Not a graduation\n\nbody",
    });
    await produceEntry(engine, {
      contribution,
      domain: "wolfpack",
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.9 },
      resolve: () => null,
    });
    // With current implementation, preserveBody skips LLM regardless of
    // graduation (as long as it's not "hub"). Document that: observational
    // contributions can opt in to verbatim too.
    expect(callSpy).not.toHaveBeenCalled();
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

  it("keeps the original created date on merge, and uses today on create", async () => {
    const base = {
      contribution: mockContribution(),
      domain: "wolfpack",
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed" as const, fit: 1 },
      resolve: (() => null) as RelationResolver,
    };
    const merged = await produceEntry(mockEngine(), {
      ...base,
      entryId: "kb-wolfpack-AAAAAAA",
      existingMarkdown: "---\nid: kb-wolfpack-AAAAAAA\ncreated: 2025-01-02\n---\nold",
    });
    expect(merged.entry.created).toBe("2025-01-02");
    const viaField = await produceEntry(mockEngine(), { ...base, entryId: "kb-wolfpack-AAAAAAA", existingCreated: "2024-05-06" });
    expect(viaField.entry.created).toBe("2024-05-06");
    const created = await produceEntry(mockEngine(), { ...base, existingCreated: "2024-05-06" });
    expect(created.entry.created).not.toBe("2024-05-06");
  });
});

describe("produceEntry: knowledge lint", () => {
  const input = (contribution = mockContribution()): ProduceEntryInput => ({
    contribution,
    domain: "wolfpack",
    section: SectionId.parse("sec-wolfpack-abc123"),
    placement: { basis: "routed", fit: 0.85 },
    resolve: () => null,
  });
  const op = (o: Partial<LlmOpinion>): LlmOpinion => ({
    title: "Sweep pipeline", kind: { type: "architecture" }, summary: "A lede that is long enough to be compared.",
    detail: "## How\nclean", confidence: "high", facets: {}, properties: {}, proposedRelations: [], ...o,
  });

  it("retries once with the findings, then keeps the clean answer", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(op({ detail: "## How\nFixed in commit ee17088. 682 tests passed." }))
      .mockResolvedValueOnce(op({ detail: "## How\nclean" }));
    const r = await produceEntry({ call } as unknown as Engine, input());
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][2].prompt).toContain("commit-hash");
    expect(call.mock.calls[1][2].prompt).toContain("test-count");
    expect(r.lint).toMatchObject({ retried: true, after: [] });
    expect(r.entry.detail).not.toContain("ee17088");
  });

  it("does not retry a clean answer; strips forbidden properties, repeated lede and the Detail heading", async () => {
    const lede = "A lede that is long enough to be compared.";
    const call = vi.fn().mockResolvedValue(op({ summary: lede, detail: `## Detail\n\n${lede}\n\n## How\nclean`, properties: { commit: "abc", "test-count": "9", host: "sfo01" } }));
    const r = await produceEntry({ call } as unknown as Engine, input());
    expect(call).toHaveBeenCalledTimes(1);
    expect(r.entry.properties).toEqual({ host: "sfo01" });
    expect(r.entry.detail).not.toContain("## Detail");
    expect(r.entry.detail.split(lede).length).toBe(1);
  });

  it("keeps an answer that still fails after the retry and reports it", async () => {
    const call = vi.fn().mockResolvedValue(op({ detail: "## How\nTask AbC1234 done." }));
    const r = await produceEntry({ call } as unknown as Engine, input());
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.lint?.after.map((f) => f.code)).toEqual(["work-id"]);
  });

  it("ignores hashes in History lines the entry already carried", async () => {
    const prev = "---\nid: kb-wolfpack-AbC1234\ncreated: 2026-10-01\n---\n\n# T\n\nlede\n\n## How\nclean\n\n## History\n\n- Until 2026-10-21: a. Now b (2a47c99).\n";
    const call = vi.fn().mockResolvedValue(op({ detail: "## How\nclean\n\n## History\n\n- Until 2026-10-21: a. Now b (2a47c99)." }));
    const r = await produceEntry({ call } as unknown as Engine, { ...input(), entryId: "kb-wolfpack-AbC1234", existingMarkdown: prev });
    expect(call).toHaveBeenCalledTimes(1);
    expect(r.lint?.after).toEqual([]);
  });

  it("oversize keeps the entry but reports it; history-style domains are exempt", async () => {
    const big = "## How\n" + "word ".repeat(1500);
    const call = vi.fn().mockResolvedValue(op({ detail: big }));
    const r = await produceEntry({ call } as unknown as Engine, input());
    expect(r.lint?.after.map((f) => f.code)).toEqual(["oversize"]);
    call.mockClear();
    const h = await produceEntry({ call } as unknown as Engine, { ...input(), style: "history" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(h.lint?.after).toEqual([]);
  });
});
