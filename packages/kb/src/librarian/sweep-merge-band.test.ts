import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep, mergeBand, contributionTitle } from "./sweep.js";
import { appendLedger } from "./ledger.js";
import { ev } from "../shared/index.js";
import type { KbRoots } from "../shared/index.js";

/** A unit vector whose cosine to [1,0,0] is `score`. */
const at = (score: number): number[] => [score, Math.sqrt(1 - score * score), 0];

describe("mergeBand", () => {
  const r = (...scores: number[]) => scores.map((score, i) => ({ id: `e${i}`, score }));
  it("creates below LOW, merges above HIGH with a margin, asks otherwise", () => {
    expect(mergeBand([])).toEqual({ kind: "create" });
    expect(mergeBand(r(0.5, 0.4))).toEqual({ kind: "create" });
    expect(mergeBand(r(0.95, 0.6))).toEqual({ kind: "merge", id: "e0" });
    expect(mergeBand(r(0.95))).toEqual({ kind: "merge", id: "e0" });
    expect(mergeBand(r(0.95, 0.94))).toEqual({ kind: "ask" }); // no lead over #2
    expect(mergeBand(r(0.8, 0.5))).toEqual({ kind: "ask" });
  });
});

describe("contributionTitle", () => {
  it("takes the first H1, else the den topic id", () => {
    expect(contributionTitle({ body: "x\n# Real Title\nbody", denTopicId: "t" })).toBe("Real Title");
    expect(contributionTitle({ body: "no heading", denTopicId: "agent-key-rotation" })).toBe("agent key rotation");
  });
});

describe("sweep: subject-checked merges", () => {
  let base: string;
  let roots: KbRoots;
  const notes: string[] = [];
  const calls: Array<{ step: string; prompt: string }> = [];
  let subjectAnswer: () => unknown;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = () => join(roots.kbBase, "domains", "wp", "entries");

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
      calls.push({ step, prompt: opts.prompt });
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      if (step === "matchSubject") return schema.parse(subjectAnswer());
      return schema.parse({
        title: "Topic", kind: { type: "fact" }, summary: "s", detail: "d",
        confidence: "high", facets: {}, properties: {}, proposedRelations: [],
      });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  const entry = (id: string, extra = "") =>
    writeFileSync(
      join(entries(), `${id}.md`),
      `---\nid: ${id}\ntitle: Title ${id}\nsummary: Summary of ${id}\nsection: sec-wp-aaaaaa\ncreated: 2025-01-02\n${extra}---\n\nbody\n`
    );
  const drop = (topic = "some-topic", hash = "c0de") =>
    writeFileSync(join(inbox(), `${topic}.md`), `---\nfrom: w1\nden_topic_id: ${topic}\ncontent_hash: ${hash}\nprev_hash: null\ndomain_hint: wp\n---\n\n# A title\n\nbody\n`);
  const run = (scores: Record<string, number>) =>
    sweep({
      engine, roots, notify: (m) => notes.push(m),
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () =>
        Object.entries(scores).map(([entryId, s]) => ({ entryId, domain: "wp", vector: at(s) })) as any,
    });
  const subjectCalls = () => calls.filter((c) => c.step === "matchSubject");
  const produceCall = () => calls.find((c) => c.step === "produce");

  beforeEach(() => {
    notes.length = 0;
    calls.length = 0;
    subjectAnswer = () => ({ match: "new" });
    base = mkdtempSync(join(tmpdir(), "kb-band-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(entries(), { recursive: true });
    entry("kb-wp-AAAAAAA");
    entry("kb-wp-BBBBBBB");
    entry("kb-wp-CCCCCCC");
    drop();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("below LOW creates, with no LLM subject check", async () => {
    expect(await run({ "kb-wp-AAAAAAA": 0.5 })).toMatchObject({ created: 1, merged: 0 });
    expect(subjectCalls()).toHaveLength(0);
  });

  it("above HIGH with a margin merges into the top entry, with no LLM subject check", async () => {
    expect(await run({ "kb-wp-AAAAAAA": 0.95, "kb-wp-BBBBBBB": 0.6 })).toMatchObject({ created: 0, merged: 1 });
    expect(subjectCalls()).toHaveLength(0);
    expect(produceCall()!.prompt).toContain("EXISTING ENTRY (kb-wp-AAAAAAA)");
  });

  it("in the middle asks the LLM with the top-3 and follows 'new'", async () => {
    subjectAnswer = () => ({ match: "new", reason: "adjacent" });
    expect(await run({ "kb-wp-AAAAAAA": 0.8, "kb-wp-BBBBBBB": 0.75, "kb-wp-CCCCCCC": 0.7 })).toMatchObject({ created: 1, merged: 0 });
    expect(subjectCalls()).toHaveLength(1);
    const p = subjectCalls()[0].prompt;
    expect(p).toContain("A title");
    for (const id of ["kb-wp-AAAAAAA", "kb-wp-BBBBBBB", "kb-wp-CCCCCCC"]) expect(p).toContain(`${id}: Title ${id}`);
    expect(p).toContain("Summary of kb-wp-AAAAAAA");
  });

  it("in the middle follows a chosen candidate id", async () => {
    subjectAnswer = () => ({ match: "kb-wp-BBBBBBB" });
    expect(await run({ "kb-wp-AAAAAAA": 0.8, "kb-wp-BBBBBBB": 0.75 })).toMatchObject({ created: 0, merged: 1 });
    expect(produceCall()!.prompt).toContain("EXISTING ENTRY (kb-wp-BBBBBBB)");
  });

  it("a high score without a lead over the runner-up still asks", async () => {
    await run({ "kb-wp-AAAAAAA": 0.95, "kb-wp-BBBBBBB": 0.94 });
    expect(subjectCalls()).toHaveLength(1);
  });

  it("an id that is not a candidate is treated as new", async () => {
    subjectAnswer = () => ({ match: "kb-wp-ZZZZZZZ" });
    expect(await run({ "kb-wp-AAAAAAA": 0.8 })).toMatchObject({ created: 1, merged: 0 });
  });

  it("an unparseable answer creates a new entry and logs it", async () => {
    subjectAnswer = () => { throw new Error("Failed to extract valid output from model"); };
    const r = await run({ "kb-wp-AAAAAAA": 0.8 });
    expect(r).toMatchObject({ created: 1, merged: 0, errors: 0 });
    expect(notes.some((n) => n.includes("unparseable"))).toBe(true);
  });

  it("an infrastructure error in the check backs off instead of creating", async () => {
    subjectAnswer = () => { throw Object.assign(new Error("rate limited"), { status: 429 }); };
    const r = await run({ "kb-wp-AAAAAAA": 0.8 });
    expect(r.created).toBe(0);
    expect(r.paused).toBeTruthy();
  });

  it("an entry an old graduation made is an ordinary entry: its alias merges into it", async () => {
    entry("kb-wp-GRADGRA", "properties:\n  graduation-commits: abc\n");
    appendLedger(roots, [
      ev.contribution({ from: "w1", denTopicId: "some-topic", hash: "old", prevHash: null, domainHint: "wp" }),
      ev.entryWritten("kb-wp-GRADGRA", "kb-wp-GRADGRA", "create"),
      ev.aliased("w1", "some-topic", "kb-wp-GRADGRA", "old"),
    ]);
    const before = readdirSync(entries()).length;
    expect(await run({ "kb-wp-GRADGRA": 0.95, "kb-wp-AAAAAAA": 0.95 })).toMatchObject({ created: 0, merged: 1 });
    expect(readdirSync(entries()).length).toBe(before);
  });

  it("keeps the original created date when merging", async () => {
    await run({ "kb-wp-AAAAAAA": 0.95 });
    const md = readFileSync(join(entries(), "kb-wp-AAAAAAA.md"), "utf8");
    expect(md).toMatch(/created: ['"]?2025-01-02/);
  });
});
