import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { historyLines, preserveHistory, normalizeDetail, foldIntro, existingRelations, supersededIds } from "./preserve.js";
import { produceEntry } from "./produce.js";
import { sweep } from "./sweep.js";
import { type KbRoots, type ParsedContribution } from "../shared/index.js";
import { SectionId } from "../schema/knowledge.js";

const H1 = "- Until 2026-10-01: A was 1. Now A is 2, because of X.";
const H2 = "- Until 2026-10-10: B was on. Now B is off.";
const PREV = `---\nid: kb-wolfpack-abc1234\ncreated: 2026-01-01\n---\n\n# T\n\nThe lede.\n\n## Body\n\nText.\n\n## History\n\n${H1}\n${H2}\n`;

describe("preserveHistory", () => {
  it("reads the lines of the final History section", () => {
    expect(historyLines(PREV)).toEqual([H1, H2]);
    expect(historyLines("---\nid: x\n---\n# T\n\nno history")).toEqual([]);
  });

  it("leaves a detail that kept every line alone", () => {
    const detail = `Body.\n\n## History\n\n${H1}\n${H2}\n- Until 2026-10-22: C. Now D.`;
    expect(preserveHistory(PREV, detail)).toEqual({ detail, restored: [] });
  });

  it("restores a dropped line before the model's own lines", () => {
    const r = preserveHistory(PREV, `Body.\n\n## History\n\n${H2}\n- Until 2026-10-22: C. Now D.`);
    expect(r.restored).toEqual([H1]);
    expect(historyLines(`---\n---\n# T\n\n${r.detail}`)).toEqual([H1, H2, "- Until 2026-10-22: C. Now D."]);
  });

  it("recreates a History section the model dropped entirely, and keeps the body", () => {
    const r = preserveHistory(PREV, "New body.");
    expect(r.restored).toEqual([H1, H2]);
    expect(r.detail).toBe(`New body.\n\n## History\n\n${H1}\n${H2}\n`);
  });

  it("compares lines ignoring whitespace, and stands down past the fold limit", () => {
    expect(preserveHistory(PREV, `x\n\n## History\n\n${H1.replace(/ /g, "  ")}\n${H2}`).restored).toEqual([]);
    const many = Array.from({ length: 16 }, (_, i) => `- Until 2026-01-${String(i + 1).padStart(2, "0")}: a. Now b.`).join("\n");
    expect(preserveHistory(`---\n---\n# T\n\n## History\n\n${many}\n`, "folded").restored).toEqual([]);
  });
});

describe("normalizeDetail", () => {
  it("drops a leading H1 and a repeated lede", () => {
    expect(normalizeDetail("# T\n\nThe lede.\n\n## Body\n\nText.", "S", PREV)).toBe("## Body\n\nText.");
    expect(normalizeDetail("# T\n\nS\n\n## Body", "S")).toBe("## Body");
  });
  it("keeps a first paragraph that is new, and plain details", () => {
    expect(normalizeDetail("Fresh intro.\n\n## Body", "S", PREV)).toBe("Fresh intro.\n\n## Body");
    expect(normalizeDetail("## Body\n\nText.", "S")).toBe("## Body\n\nText.");
  });
});

describe("foldIntro", () => {
  it("moves intro prose into the lede unless the entry used a Detail wrapper", () => {
    expect(foldIntro("Lede.", "More lede.\n\n## Body\n\nText.", PREV)).toEqual({ summary: "Lede.\n\nMore lede.", detail: "## Body\n\nText." });
    expect(foldIntro("Lede.", "More.\n\n## Body", `${PREV}\n## Detail\n`)).toEqual({ summary: "Lede.", detail: "More.\n\n## Body" });
    expect(foldIntro("Lede.", "More.\n\n## Body")).toEqual({ summary: "Lede.", detail: "More.\n\n## Body" });
    expect(foldIntro("Lede.", "## Body", PREV)).toEqual({ summary: "Lede.", detail: "## Body" });
  });
});

describe("existingRelations", () => {
  it("reads typed and legacy relations, dropping invalid ones", () => {
    const md = [
      "---", "id: kb-wolfpack-abc1234",
      "relations:", "  - kind: see_also", "    target: kb-wolfpack-ZZZZZZZ", "    source: code", "    weight: 0.500",
      "  - kind: nonsense", "    target: x", "    source: code",
      "related:", "  - rel: supersedes", "    target: kb-wolfpack-YYYYYYY",
      "---", "", "# T",
    ].join("\n");
    expect(existingRelations(md)).toEqual([
      { kind: "see_also", target: "kb-wolfpack-ZZZZZZZ", source: "code", weight: 0.5 },
      { kind: "supersedes", target: "kb-wolfpack-YYYYYYY", source: "code" },
    ]);
  });
});

function contribution(over: Partial<ParsedContribution> = {}): ParsedContribution {
  return { from: "w", denTopicId: "t1", summary: "s", body: "b", contentHash: "h", filePath: "/tmp/x.md", currency: "live", ...over } as ParsedContribution;
}
function engineReturning(opinion: Record<string, unknown>) {
  const call = vi.fn().mockResolvedValue({
    title: "Test title", kind: { type: "architecture" }, summary: "S", detail: "Body", confidence: "high",
    facets: {}, properties: {}, proposedRelations: [], ...opinion,
  });
  return { engine: { call } as unknown as Engine, call };
}
const input = {
  domain: "wolfpack",
  section: SectionId.parse("sec-wolfpack-abc123"),
  placement: { basis: "routed" as const, fit: 1 },
  resolve: () => null,
};

describe("produceEntry guards", () => {
  const relPrev = `---\nid: kb-wolfpack-abc1234\nkind: architecture\ncreated: 2026-01-01\nrelations:\n  - kind: see_also\n    target: kb-wolfpack-ZZZZZZZ\n    source: code\n---\n\n# T\n\nThe lede.\n\n## Body\n\nOld.\n\n## History\n\n${H1}\n`;

  it("a merge restores dropped History lines, keeps relations and strips the repeated H1 + lede", async () => {
    const { engine } = engineReturning({ detail: "# T\n\nThe lede.\n\n## Body\n\nNew." });
    const r = await produceEntry(engine, { ...input, contribution: contribution(), entryId: "kb-wolfpack-abc1234", existingMarkdown: relPrev });
    expect(r.historyRestored).toEqual([H1]);
    expect(r.entry.detail).toBe(`## Body\n\nNew.\n\n## History\n\n${H1}\n`);
    expect(r.entry.relations).toContainEqual({ kind: "see_also", target: "kb-wolfpack-ZZZZZZZ", source: "code" });
  });

  it("a graduation regenerated from its dossier keeps the previous History", async () => {
    const { engine, call } = engineReturning({ detail: "Built X." });
    const r = await produceEntry(engine, {
      ...input,
      contribution: contribution({ graduation: "feature", entryId: "kb-wolfpack-abc1234" } as Partial<ParsedContribution>),
      entryId: "kb-wolfpack-abc1234",
      previousMarkdown: PREV,
    });
    expect(call.mock.calls[0][2].prompt).not.toContain("EXISTING ENTRY");
    expect(r.entry.detail).toContain("## History");
    expect(r.entry.detail).toContain(H1);
    expect(r.entry.detail).toContain(H2);
    expect(r.entry.created).toBe("2026-01-01");
  });

  it("a verbatim graduation keeps the previous History too", async () => {
    const { engine } = engineReturning({});
    const r = await produceEntry(engine, {
      ...input,
      contribution: contribution({ graduation: "feature", preserveBody: true, body: "# Spec\n\nVerbatim body." } as Partial<ParsedContribution>),
      entryId: "kb-wolfpack-abc1234",
      previousMarkdown: PREV,
    });
    expect(r.entry.detail).toBe(`Verbatim body.\n\n## History\n\n${H1}\n${H2}\n`);
  });

  it("a superseding decision does not inherit the old decision's History", async () => {
    const dec = `---\nid: kb-wolfpack-abc1234\nkind: decision\ncreated: 2026-01-01\n---\n\n# D\n\nWe use A.\n\n## History\n\n${H1}\n`;
    const { engine } = engineReturning({ kind: { type: "decision" }, detail: "We use B.", supersedesDecision: true });
    const r = await produceEntry(engine, { ...input, contribution: contribution(), entryId: "kb-wolfpack-abc1234", existingMarkdown: dec });
    expect(r.supersedes).toBe("kb-wolfpack-abc1234");
    expect(r.entry.detail).toBe("We use B.");
    expect(r.entry.relations).toEqual([{ kind: "supersedes", target: "kb-wolfpack-abc1234", source: "code", weight: 1 }]);
  });

  it("every domain gets the same prompt: current state plus History", async () => {
    for (const domain of ["snapjack", "wolfpack"]) {
      const a = engineReturning({});
      await produceEntry(a.engine, { ...input, domain, contribution: contribution() });
      const sys = a.call.mock.calls[0][2].system as string;
      expect(sys).not.toContain("DOMAIN STYLE");
      expect(sys).toContain("see versions/ for prior text");
    }
  });
});

describe("superseded decisions and snapjack merges", () => {
  let base: string;
  let roots: KbRoots;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-preserve-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(join(roots.kbBase, "domains", "wp", "entries"), { recursive: true });
    mkdirSync(join(roots.opsRoot, "inbox", "w1"), { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("supersededIds maps an old decision to the entry that replaced it", () => {
    const dir = join(roots.kbBase, "domains", "wp", "entries");
    writeFileSync(join(dir, "kb-wp-NEWNEWN.md"), "---\nid: kb-wp-NEWNEWN\nrelations:\n  - kind: supersedes\n    target: kb-wp-OLDOLDO\n    source: code\n---\n\n# N\n");
    writeFileSync(join(dir, "kb-wp-OLDOLDO.md"), "---\nid: kb-wp-OLDOLDO\n---\n\n# O\n");
    expect([...supersededIds(roots, "wp")]).toEqual([["kb-wp-OLDOLDO", "kb-wp-NEWNEWN"]]);
  });

  it("the sweep never merges into a superseded decision: it goes to the newest one", async () => {
    const dir = join(roots.kbBase, "domains", "wp", "entries");
    const dec = (id: string, rel = "") =>
      writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\nkind: decision\nsection: sec-wp-aaaaaa\ncreated: 2025-01-02\n${rel}---\n\n# ${id}\n\nWe do A.\n`);
    dec("kb-wp-OLDOLDO");
    dec("kb-wp-NEWNEWN", "relations:\n  - kind: supersedes\n    target: kb-wp-OLDOLDO\n    source: code\n");
    writeFileSync(join(roots.opsRoot, "inbox", "w1", "t.md"), "---\nfrom: w1\nden_topic_id: t\ncontent_hash: c1\nprev_hash: null\ndomain_hint: wp\n---\n\n# A title\n\nbody\n");
    const prompts: string[] = [];
    const engine = {
      call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
        if (step === "produce") prompts.push(opts.prompt);
        if (step === "matchSubject") return schema.parse({ match: "kb-wp-OLDOLDO" });
        return schema.parse({ title: "Test title", kind: { type: "decision" }, summary: "s", detail: "d", confidence: "high", facets: {}, properties: {}, proposedRelations: [] });
      }),
      usage: { summarize: () => ({}) },
    } as unknown as Engine;
    const at = (s: number) => [s, Math.sqrt(1 - s * s), 0];
    await sweep({
      engine, roots, notify: () => {},
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () => [
        { entryId: "kb-wp-OLDOLDO", domain: "wp", vector: at(0.97) },
        { entryId: "kb-wp-NEWNEWN", domain: "wp", vector: at(0.9) },
      ] as any,
    });
    expect(prompts[0]).toContain("EXISTING ENTRY (kb-wp-NEWNEWN)");
    expect(readFileSync(join(dir, "kb-wp-OLDOLDO.md"), "utf-8")).toContain("We do A.");
  });

  it("a snapjack merge replaces the superseded fact in the body and records it in History", async () => {
    const dir = join(roots.kbBase, "domains", "snapjack", "entries");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kb-snapjack-GAMEGAM.md"), "---\nid: kb-snapjack-GAMEGAM\ntitle: Game rooms\nkind: architecture\nsection: sec-snapjack-aaaaaa\ncreated: 2026-03-01\nupdated: 2026-03-01\n---\n\n# Game rooms\n\nA room holds players.\n\n## Limits\n\nA room holds at most 4 players.\n");
    mkdirSync(join(roots.opsRoot, "inbox", "w1"), { recursive: true });
    writeFileSync(join(roots.opsRoot, "inbox", "w1", "t.md"), "---\nfrom: w1\nden_topic_id: t\ncontent_hash: c1\nprev_hash: null\ndomain_hint: snapjack\n---\n\n# Game rooms\n\nA room now holds at most 6 players.\n");
    const systems: string[] = [];
    const engine = {
      call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { system: string }) => {
        if (step === "produce") systems.push(opts.system);
        return schema.parse({
          title: "Game rooms", kind: { type: "architecture" }, summary: "A room holds players.",
          detail: "## Limits\n\nA room holds at most 6 players.\n\n## History\n\n- Until 2026-10-22: a room held at most 4 players. Now it holds 6, because the product raised the cap.",
          confidence: "high", facets: {}, properties: {}, proposedRelations: [],
        });
      }),
      usage: { summarize: () => ({}) },
    } as unknown as Engine;
    await sweep({
      engine, roots, notify: () => {},
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () => [{ entryId: "kb-snapjack-GAMEGAM", domain: "snapjack", vector: [1, 0, 0] }] as any,
    });
    expect(systems[0]).not.toContain("DOMAIN STYLE");
    const md = readFileSync(join(dir, "kb-snapjack-GAMEGAM.md"), "utf-8");
    const [body, history] = md.split("## History");
    expect(body).toContain("at most 6 players");
    expect(body).not.toContain("at most 4 players");
    expect(history).toContain("Until 2026-10-22: a room held at most 4 players. Now it holds 6");
  });
});
