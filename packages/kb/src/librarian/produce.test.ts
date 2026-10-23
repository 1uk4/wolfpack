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

  it("a size pass fixes an entry that is only oversize", async () => {
    const big = "## How\n" + "word ".repeat(1500);
    const call = vi.fn().mockResolvedValueOnce(op({ detail: big })).mockResolvedValueOnce(op({ detail: big })).mockResolvedValueOnce(op({ detail: "## How\nshort" }));
    const r = await produceEntry({ call } as unknown as Engine, input());
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[2][2].prompt).toContain("condense the body");
    expect(r.lint).toMatchObject({ sizePass: true, after: [] });
  });

  it("no size pass when another finding remains", async () => {
    const call = vi.fn().mockResolvedValue(op({ detail: "## How\nTask AbC1234 done." }));
    const r = await produceEntry({ call } as unknown as Engine, input());
    expect(r.lint?.sizePass).toBe(false);
  });

  it("oversize keeps the entry but reports it, in every domain", async () => {
    const big = "## How\n" + "word ".repeat(1500);
    const call = vi.fn().mockResolvedValue(op({ detail: big }));
    const r = await produceEntry({ call } as unknown as Engine, input());
    expect(r.lint?.after.map((f) => f.code)).toEqual(["oversize"]);
    const sj = await produceEntry({ call } as unknown as Engine, { ...input(), domain: "snapjack" });
    expect(sj.lint?.after.map((f) => f.code)).toEqual(["oversize"]);
  });
});

describe("produceEntry: size counts the whole entry on a merge", () => {
  it("flags an oversize merge even when most lines were already in the entry", async () => {
    const old = "## How\n" + Array.from({ length: 400 }, (_, i) => `Line ${i} of existing prose.`).join("\n");
    const prev = `---\nid: kb-wolfpack-AbC1234\ncreated: 2026-10-01\n---\n\n# T\n\nlede\n\n${old}\n`;
    const call = vi.fn().mockResolvedValue({
      title: "Sweep pipeline", kind: { type: "architecture" }, summary: "A lede that is long enough to be compared.",
      detail: old + "\nOne new line.", confidence: "high", facets: {}, properties: {}, proposedRelations: [],
    });
    const r = await produceEntry({ call } as unknown as Engine, {
      contribution: mockContribution(), domain: "wolfpack", section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 }, resolve: () => null, entryId: "kb-wolfpack-AbC1234", existingMarkdown: prev,
    });
    expect(call).toHaveBeenCalledTimes(3); // retried for oversize, then one size pass
    expect(r.lint?.after.map((f) => f.code)).toEqual(["oversize"]);
    expect(r.lint?.oversizeChars).toBeGreaterThan(6000);
  });
});

describe("produceEntry: prevent at source", () => {
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
    const live = new Set(["kb-wolfpack-AAAAAAA"]);

    it("a size pass offers the split; an overflow comes back with the trimmed entry", async () => {
      const big = "## How\n" + "word ".repeat(1500);
      const call = vi.fn()
        .mockResolvedValueOnce(op({ detail: big }))
        .mockResolvedValueOnce(op({ detail: big }))
        .mockResolvedValueOnce(op({ detail: "## How\nshort", overflow: { title: "Syncthing setup", summary: "How sync is wired.", detail: "## Wiring\nfolders" } }));
      const r = await produceEntry({ call } as unknown as Engine, input());
      expect(call.mock.calls[2][2].prompt).toContain("TWO subjects");
      expect(r.overflow).toEqual({ title: "Syncthing setup", summary: "How sync is wired.", body: "## Wiring\nfolders" });
      expect(r.lint?.after).toEqual([]);
    });

    it("an entry still over the cap after a split gets a condense pass that keeps the overflow", async () => {
      const big = "## How\n" + "word ".repeat(1500);
      const ov = { title: "Syncthing setup", summary: "How sync is wired.", detail: "## Wiring\nfolders" };
      const call = vi.fn()
        .mockResolvedValueOnce(op({ detail: big, overflow: ov }))
        .mockResolvedValueOnce(op({ detail: big, overflow: ov }))
        .mockResolvedValueOnce(op({ detail: "## How\nshort" }));
      const r = await produceEntry({ call } as unknown as Engine, input());
      expect(call).toHaveBeenCalledTimes(3);
      expect(call.mock.calls[2][2].prompt).not.toContain("TWO subjects");
      expect(r.overflow?.title).toBe("Syncthing setup");
      expect(r.lint?.after).toEqual([]);
    });

    it("text of the split-out subject that the model also left in the entry is dropped from it", async () => {
      const P = "Syncthing runs as a star around Dewey, with a Mac hub and four folder types per wolf, all receive-only.";
      const call = vi.fn().mockResolvedValue(op({
        detail: `## Layout\nThe ledger is one append-only file per den, read by every command.\n\n## Topology\n${P}`,
        overflow: { title: "Syncthing topology", summary: "How sync is wired.", detail: `## Topology\n${P}` },
      }));
      const r = await produceEntry({ call } as unknown as Engine, input());
      expect(r.entry.detail).toContain("## Layout");
      expect(r.entry.detail).not.toContain("Syncthing");
      expect(r.overflow?.body).toContain("Syncthing runs");
    });

    it("Delivered links to retired entries become their survivors; ones with none are dropped", async () => {
      const body = "## Delivered\n\n- Feature A: [[kb-wolfpack-Old1111]], [[kb-wolfpack-Live111]]\n- Feature B: [[kb-wolfpack-Gone333]]";
      const call = vi.fn().mockResolvedValue(op({ detail: "## How\nclean\n\n## Delivered\n\n- Feature A: [[kb-wolfpack-Old1111]]" }));
      const map = (ls: string[]) => [...new Set(ls.flatMap((l) => (l === "kb-wolfpack-Old1111" ? ["kb-wolfpack-Surv222"] : l === "kb-wolfpack-Gone333" ? [] : [l])))];
      const r = await produceEntry({ call } as unknown as Engine, { ...input(mockContribution({ body })), resolveLinks: map });
      expect(r.entry.detail).toContain("- Feature A: [[kb-wolfpack-Surv222]], [[kb-wolfpack-Live111]]");
      expect(r.entry.detail).toContain("- Feature B");
      expect(r.entry.detail).not.toMatch(/Old1111|Gone333/);
    });

    it("with overflow not allowed the size pass condenses and an overflow is ignored", async () => {
      const big = "## How\n" + "word ".repeat(1500);
      const call = vi.fn()
        .mockResolvedValueOnce(op({ detail: big }))
        .mockResolvedValueOnce(op({ detail: big }))
        .mockResolvedValueOnce(op({ detail: "## How\nshort", overflow: { title: "Another thing", summary: "s", detail: "d" } }));
      const r = await produceEntry({ call } as unknown as Engine, { ...input(), allowOverflow: false });
      expect(call.mock.calls[0][2].prompt).toContain("OVERFLOW: not allowed");
      expect(call.mock.calls[2][2].prompt).not.toContain("TWO subjects");
      expect(r.overflow).toBeUndefined();
    });

    it("an overflow in the first answer, entry within the cap, needs no size pass", async () => {
      const call = vi.fn().mockResolvedValue(op({ overflow: { title: "Second subject", summary: "s", detail: "d" } }));
      const r = await produceEntry({ call } as unknown as Engine, input());
      expect(call).toHaveBeenCalledTimes(1);
      expect(r.overflow?.title).toBe("Second subject");
    });

    it("a link to no entry makes produce retry; a surviving one is stripped, text kept", async () => {
      const bad = op({ detail: "## How\nSee [[kb-...]] and [[NEW-thing|the thing]] and [[kb-wolfpack-AAAAAAA]]." });
      const call = vi.fn().mockResolvedValue(bad);
      const r = await produceEntry({ call } as unknown as Engine, { ...input(), liveIds: live });
      expect(call).toHaveBeenCalledTimes(2);
      expect(call.mock.calls[1][2].prompt).toContain("broken-link");
      expect(r.entry.detail).toContain("See kb-... and the thing and [[kb-wolfpack-AAAAAAA]].");
      expect(r.lint?.strippedLinks).toEqual(["kb-...", "NEW-thing"]);
      expect(r.lint?.after).toEqual([]);
    });

    it("without live ids links are not checked", async () => {
      const call = vi.fn().mockResolvedValue(op({ detail: "## How\nSee [[kb-...]]." }));
      await produceEntry({ call } as unknown as Engine, input());
      expect(call).toHaveBeenCalledTimes(1);
    });

    it("collapses a restated section and a restated History line, keeping the previous History", async () => {
      const prev = "---\nid: kb-wolfpack-AbC1234\ncreated: 2026-10-01\n---\n\n# T\n\nlede\n\n## Principle\nThe sweep merges a contribution into an entry only when the subject is the same.\n\n## History\n\n- Until 2026-10-20: the sweep routed every contribution by similarity alone. Now it routes by alias first (work-wolfpack-AbC1234).\n";
      const detail = "## Principle\nThe sweep merges a contribution into an entry only when the subject is the same.\n\n## Rehearsal\nThe sweep merges a contribution into an entry only when the subject is the same.\n\n## History\n\n- Until 2026-10-20: the sweep routed every contribution by similarity alone. Now it routes by alias first (work-wolfpack-AbC1234).\n- Until 2026-10-23: the sweep routed each contribution by similarity alone. Now it routes by alias first (work-wolfpack-AbC1234).";
      const call = vi.fn().mockResolvedValue(op({ detail }));
      const r = await produceEntry({ call } as unknown as Engine, { ...input(), entryId: "kb-wolfpack-AbC1234", existingMarkdown: prev });
      expect(r.entry.detail.match(/only when the subject is the same/g)).toHaveLength(1);
      expect(r.entry.detail).not.toContain("## Rehearsal");
      expect(r.entry.detail.match(/by similarity alone/g)).toHaveLength(1);
      expect(r.deduped).toHaveLength(2);
    });
});
