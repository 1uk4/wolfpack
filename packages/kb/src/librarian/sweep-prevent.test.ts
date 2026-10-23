import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep, overflowContribution, liveEntryIds } from "./sweep.js";
import { readLedger, foldRegistry } from "./ledger.js";
import type { KbRoots } from "../shared/index.js";

/** A unit vector whose cosine to [1,0,0] is `score`. */
const at = (score: number): number[] => [score, Math.sqrt(1 - score * score), 0];

describe("sweep: prevent at source", () => {
  let base: string;
  let roots: KbRoots;
  const notes: string[] = [];
  const calls: Array<{ step: string; prompt: string }> = [];
  let subjectAnswer: () => unknown;
  let confirmAnswer: () => unknown;
  let produceOpinions: Array<Record<string, unknown>>;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = () => join(roots.kbBase, "domains", "wp", "entries");

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
      calls.push({ step, prompt: opts.prompt });
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      if (step === "matchSubject") return schema.parse(subjectAnswer());
      if (step === "confirmSubject") return schema.parse(confirmAnswer());
      const n = calls.filter((c) => c.step === "produce").length - 1;
      return schema.parse({
        title: "Topic", kind: { type: "fact" }, summary: "s", detail: "d",
        confidence: "high", facets: {}, properties: {}, proposedRelations: [],
        ...(produceOpinions[n] ?? {}),
      });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  const entry = (id: string) =>
    writeFileSync(
      join(entries(), `${id}.md`),
      `---\nid: ${id}\ntitle: Title ${id}\nsummary: Summary of ${id}\nsection: sec-wp-aaaaaa\ncreated: 2025-01-02\n---\n\nFULL BODY OF ${id}\n`
    );
  const drop = (extra = "") =>
    writeFileSync(join(inbox(), "some-topic.md"), `---\nfrom: w1\nden_topic_id: some-topic\ncontent_hash: c0de\nprev_hash: null\ndomain_hint: wp\n${extra}---\n\n# A title\n\nFULL BODY OF THE CONTRIBUTION\n`);
  const run = (scores: Record<string, number>) =>
    sweep({
      engine, roots, notify: (m) => notes.push(m),
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () =>
        Object.entries(scores).map(([entryId, s]) => ({ entryId, domain: "wp", vector: at(s) })) as any,
    });
  const step = (s: string) => calls.filter((c) => c.step === s);
  const receipt = () => {
    const dir = join(roots.opsRoot, "receipts", "w1");
    return readFileSync(join(dir, readdirSync(dir)[0]), "utf8");
  };

  beforeEach(() => {
    notes.length = 0;
    calls.length = 0;
    subjectAnswer = () => ({ match: "new" });
    confirmAnswer = () => ({ verdict: "different" });
    produceOpinions = [];
    base = mkdtempSync(join(tmpdir(), "kb-prevent-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(entries(), { recursive: true });
    entry("kb-wp-AAAAAAA");
    entry("kb-wp-BBBBBBB");
    drop();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  describe("near-miss creates", () => {
    it("a top score ≥ 0.80 that the subject check calls new gets a second look with both full bodies", async () => {
      confirmAnswer = () => ({ verdict: "merge", reason: "same subject" });
      expect(await run({ "kb-wp-AAAAAAA": 0.82, "kb-wp-BBBBBBB": 0.5 })).toMatchObject({ created: 0, merged: 1 });
      expect(step("confirmSubject")).toHaveLength(1);
      const p = step("confirmSubject")[0].prompt;
      expect(p).toContain("FULL BODY OF THE CONTRIBUTION");
      expect(p).toContain("FULL BODY OF kb-wp-AAAAAAA");
      expect(step("produce")[0].prompt).toContain("EXISTING ENTRY (kb-wp-AAAAAAA)");
      expect(receipt()).toMatch(/"confirm":\{"candidate":"kb-wp-AAAAAAA","score":0\.82,"merge":true/);
    });

    it("creates only when the second look says different, and records it", async () => {
      expect(await run({ "kb-wp-AAAAAAA": 0.82 })).toMatchObject({ created: 1, merged: 0 });
      expect(step("confirmSubject")).toHaveLength(1);
      expect(receipt()).toMatch(/"confirm":\{"candidate":"kb-wp-AAAAAAA","score":0\.82,"merge":false,"valid":true/);
    });

    it("an unparseable second answer creates, like the first check", async () => {
      confirmAnswer = () => { throw new Error("Failed to extract valid output from model"); };
      expect(await run({ "kb-wp-AAAAAAA": 0.85 })).toMatchObject({ created: 1, errors: 0 });
    });

    it("below 0.80 with no hint there is no second look", async () => {
      await run({ "kb-wp-AAAAAAA": 0.75 });
      expect(step("matchSubject")).toHaveLength(1);
      expect(step("confirmSubject")).toHaveLength(0);
    });

    it("the target hint is checked again whatever its score", async () => {
      drop("target: kb-wp-BBBBBBB\n");
      confirmAnswer = () => ({ verdict: "merge" });
      expect(await run({ "kb-wp-AAAAAAA": 0.5, "kb-wp-BBBBBBB": 0.3 })).toMatchObject({ created: 0, merged: 1 });
      expect(step("confirmSubject")[0].prompt).toContain("kb-wp-BBBBBBB");
    });

    it("no second look when the first check merged", async () => {
      subjectAnswer = () => ({ match: "kb-wp-AAAAAAA" });
      await run({ "kb-wp-AAAAAAA": 0.85 });
      expect(step("confirmSubject")).toHaveLength(0);
    });
  });

  describe("split instead of condense", () => {
    const overflow = { title: "Syncthing setup", summary: "How folders sync.", detail: "## Wiring\nfolders" };

    it("writes the entry, then routes the overflow like a new contribution, keeping the alias on the main entry", async () => {
      produceOpinions = [{ overflow }, { title: "Syncthing setup", summary: "How folders sync.", detail: "## Wiring\nfolders", overflow: { title: "Third thing", summary: "s", detail: "d" } }];
      const r = await run({ "kb-wp-AAAAAAA": 0.3 });
      expect(r).toMatchObject({ processed: 1, created: 2, merged: 0, errors: 0 });
      expect(step("produce")).toHaveLength(2);
      expect(step("produce")[0].prompt).toContain("OVERFLOW: allowed");
      expect(step("produce")[1].prompt).toContain("OVERFLOW: not allowed");
      expect(step("produce")[1].prompt).toContain("How folders sync.");
      // the overflow is a new entry, never a third
      expect(readdirSync(entries()).length).toBe(2 + 2);
      const reg = foldRegistry(readLedger(roots));
      const aliases = [...reg.values()].flatMap((t) => t.aliases.map((a) => `${a.denTopicId}`));
      expect(aliases).toContain("some-topic");
      expect(aliases.some((a) => a.startsWith("some-topic~split-syncthing-setup"))).toBe(true);
      expect(receipt()).toMatch(/"overflow":\{"title":"Syncthing setup","denTopicId":"some-topic~split-syncthing-setup","target":"kb-wp-/);
    });

    it("an overflow never routes back into the entry it was split from", async () => {
      produceOpinions = [{ overflow }];
      // The embedder is constant: the overflow would score 0.95 against kb-wp-AAAAAAA too.
      const r = await run({ "kb-wp-AAAAAAA": 0.95 });
      expect(r).toMatchObject({ processed: 1, created: 1, merged: 1 });
      expect(receipt()).toMatch(/"overflow":\{[^}]*"action":"create"/);
      expect(receipt()).not.toMatch(/"overflow":\{[^}]*"target":"kb-wp-AAAAAAA"/);
    });

    it("a failing overflow route queues it as its own item instead of losing it", async () => {
      produceOpinions = [{ overflow }];
      let n = 0;
      const e = engine.call as unknown as ReturnType<typeof vi.fn>;
      const orig = e.getMockImplementation()!;
      e.mockImplementation(async (s: string, schema: any, opts: any) => {
        if (s === "produce" && ++n === 2) throw new Error("model said something broken");
        return orig(s, schema, opts);
      });
      const r = await run({ "kb-wp-AAAAAAA": 0.3 });
      e.mockImplementation(orig);
      expect(r).toMatchObject({ processed: 1, created: 1, errors: 0 });
      const queued = readdirSync(inbox()).filter((f) => f.endsWith(".md"));
      expect(queued).toEqual(["some-topic~split-syncthing-setup.md"]);
      expect(readFileSync(join(inbox(), queued[0]), "utf8")).toContain("## Wiring");
      expect(receipt()).toContain('"route":"queued"');
    });
  });

  it("liveEntryIds lists every domain's entries", () => {
    mkdirSync(join(roots.kbBase, "domains", "other", "entries"), { recursive: true });
    writeFileSync(join(roots.kbBase, "domains", "other", "entries", "kb-other-ZZZZZZZ.md"), "x");
    expect([...liveEntryIds(roots)].sort()).toEqual(["kb-other-ZZZZZZZ", "kb-wp-AAAAAAA", "kb-wp-BBBBBBB"]);
    expect(existsSync(inbox())).toBe(true);
  });

  it("overflowContribution has its own den topic id, no anchor or target", () => {
    const o = overflowContribution(
      { from: "w1", denTopicId: "t", anchor: "a", target: "kb-x-1234567", filePath: "/i/t.md", body: "b", summary: "s", contentHash: "h", prevHash: "p", domainHint: "wp", change: "merge" } as any,
      { title: "Two Things!", summary: "s2", body: "b2" }, "wp",
    );
    expect(o).toMatchObject({ denTopicId: "t~split-two-things", anchor: undefined, target: undefined, prevHash: null, domainHint: "wp" });
    expect(o.body).toContain("# Two Things!");
  });
});
