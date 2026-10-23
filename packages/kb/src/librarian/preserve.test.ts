import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { addCitedHistory, dedupeDetail, textSimilarity, historyLines, preserveHistory, normalizeDetail, foldIntro, existingRelations, supersededIds } from "./preserve.js";
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

describe("addCitedHistory", () => {
  const W = "work-wolfpack-ggNO3Sv";
  const LINE = `- 2026-10-22: sweep takes one item per run (${W})`;
  const body = (h: string) => `Lede.\n\n# T\n\n## How\n\nx\n\n## History\n\n${h}\n`;

  it("appends a cited History line the entry does not have, creating the section when needed", () => {
    expect(addCitedHistory("## How\n\nnew.", body(LINE))).toEqual({ detail: `## How\n\nnew.\n\n## History\n\n${LINE}\n`, added: [LINE] });
    const r = addCitedHistory(`## How\n\nnew.\n\n## History\n\n${H1}`, body(LINE));
    expect(r.detail).toBe(`## How\n\nnew.\n\n## History\n\n${H1}\n${LINE}\n`);
  });

  it("leaves it alone when the entry already cites that work, however the model worded the line", () => {
    const own = `- Until 2026-10-22: one per run was not enforced. Now it is (${W}).`;
    const detail = `## How\n\nnew.\n\n## History\n\n${own}`;
    expect(addCitedHistory(detail, body(LINE))).toEqual({ detail, added: [] });
  });

  it("ignores History lines without a work citation and bodies without History", () => {
    expect(addCitedHistory("x", body("- 2026-10-22: no citation")).added).toEqual([]);
    expect(addCitedHistory("x", "Lede.\n\n# T\n\n## How\n\nno history").added).toEqual([]);
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

  it("a merge that drops a Delivered link gets it back, without duplicating the model's lines", async () => {
    const prev = `---\nid: kb-wolfpack-abc1234\nkind: architecture\ncreated: 2026-01-01\nanchor: work-wolfpack-AAAAAAA\n---\n\n# T\n\nThe lede.\n\n## Scope\n\nOld.\n\n## Delivered\n\n- Base image: [[kb-wolfpack-CCCCCCC]], [[kb-wolfpack-DDDDDDD]]\n- Compose: [[kb-wolfpack-EEEEEEE]]\n\n## History\n\n${H1}\n`;
    const { engine } = engineReturning({ detail: "## Scope\n\nNew.\n\n## Delivered\n\n- Base image: [[kb-wolfpack-CCCCCCC]]\n\n## History\n\n" + H1 });
    const body = "## Delivered\n\n- Healthchecks: [[kb-wolfpack-FFFFFFF]]\n- Base image: [[kb-wolfpack-CCCCCCC]]\n";
    const r = await produceEntry(engine, { ...input, contribution: contribution({ body }), entryId: "kb-wolfpack-abc1234", existingMarkdown: prev });
    expect(r.entry.detail.match(/## Delivered/g)).toHaveLength(1);
    expect(r.entry.detail).toContain("- Base image: [[kb-wolfpack-CCCCCCC]], [[kb-wolfpack-DDDDDDD]]");
    expect(r.entry.detail).toContain("- Compose: [[kb-wolfpack-EEEEEEE]]");
    expect(r.entry.detail).toContain("- Healthchecks: [[kb-wolfpack-FFFFFFF]]");
    expect(r.entry.detail.indexOf("## Delivered")).toBeLessThan(r.entry.detail.indexOf("## History"));
  });

  it("a History line citing a work id passes the lint; the id in the body does not", async () => {
    const cite = "- 2026-10-22: sweep takes one item per run (work-wolfpack-ggNO3Sv).";
    const ok = engineReturning({ detail: `## Body\n\nNew.\n\n## History\n\n${cite}\n` });
    const r = await produceEntry(ok.engine, { ...input, contribution: contribution() });
    expect(r.lint?.before).toEqual([]);
    expect(r.entry.detail).toContain(cite);

    const bad = engineReturning({ detail: "## Body\n\nNew, from work-wolfpack-ggNO3Sv." });
    const r2 = await produceEntry(bad.engine, { ...input, contribution: contribution() });
    expect(r2.lint?.before.map((f) => f.code)).toContain("work-id");
    expect(r2.lint?.retried).toBe(true);
  });

  it("a model that drops the contribution's cited History line does not lose it", async () => {
    const W = "work-wolfpack-ggNO3Sv";
    const LINE = `- 2026-10-22: sweep takes one item per run (${W})`;
    const { engine } = engineReturning({ detail: "## How\n\nOne item per run." });
    const r = await produceEntry(engine, { ...input, contribution: contribution({ body: `Lede.\n\n# T\n\n## How\n\nx\n\n## History\n\n${LINE}\n` }) });
    expect(r.entry.detail).toBe(`## How\n\nOne item per run.\n\n## History\n\n${LINE}\n`);
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

describe("dedupeDetail", () => {
  const P = "The sweep routes a contribution to an entry by alias first, then by similarity band, then by a subject check.";
  it("measures normalized similarity", () => {
    expect(textSimilarity("A b c d e f g.", "a B c d e f g")).toBe(1);
    expect(textSimilarity(P, "Totally different words about the memory timer and its interval.")).toBeLessThan(0.2);
  });
  it("drops a near-duplicate paragraph and bullet, and the section it empties", () => {
    const d = `## One\n\n${P}\n\n- first bullet that says something quite specific here\n\n## Two\n\n${P}\n\n- first bullet that says something quite specific here.\n\n## Three\n\nkept text`;
    const r = dedupeDetail(d);
    expect(r.removed).toHaveLength(2);
    expect(r.detail).toContain("## One");
    expect(r.detail).not.toContain("## Two");
    expect(r.detail).toContain("## Three");
    expect(r.detail.match(/first bullet/g)).toHaveLength(1);
  });
  it("leaves short lines, code blocks and distinct text alone", () => {
    const d = "## A\n\n- yes\n- yes\n\n```\nsame same same same same same same\nsame same same same same same same\n```\n\n## B\n\nA wholly different paragraph about something else entirely, with enough words.";
    expect(dedupeDetail(d)).toEqual({ detail: d, removed: [] });
  });
  it("dedupes History lines with the same work id and fact, never a kept one", () => {
    const a = "- Until 2026-10-20: the KB had two entries for one subject. Now one (work-wolfpack-AbC1234).";
    const b = "- Until 2026-10-23: the KB had two entries for the one subject. Now one entry (work-wolfpack-AbC1234).";
    const other = "- Until 2026-10-21: a is on. Now off (work-wolfpack-ZzZ9999).";
    expect(dedupeDetail(`Body.\n\n## History\n\n${a}\n${b}\n${other}`).detail).toBe(`Body.\n\n## History\n\n${a}\n${other}`);
    expect(dedupeDetail(`Body.\n\n## History\n\n${a}\n${b}`, new Set([b])).removed).toEqual([]);
  });
  it("drops what repeats text that lives elsewhere now", () => {
    const moved = "## Topology\n\nThe pack syncs a star of Syncthing folders around Dewey plus a Mac hub, receive-only on wolves.";
    const d = "## Layout\n\nOne ledger file per den, read by every command of the kb CLI.\n\n" + moved;
    const r = dedupeDetail(d, new Set(), moved);
    expect(r.detail.trim()).toBe("## Layout\n\nOne ledger file per den, read by every command of the kb CLI.");
    expect(r.removed).toHaveLength(1);
  });
});
