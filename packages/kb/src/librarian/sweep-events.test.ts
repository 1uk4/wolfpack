/** The sweep's structured onEvent callback: started once per real run, one item per contribution that ends in create / merge / reject / parked. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep, type SweepEvent } from "./sweep.js";
import type { KbRoots } from "../shared/index.js";

const at = (score: number): number[] => [score, Math.sqrt(1 - score * score), 0];

describe("sweep onEvent", () => {
  let base: string;
  let roots: KbRoots;
  let events: SweepEvent[];
  let n = 0;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = () => join(roots.kbBase, "domains", "wp", "entries");

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      return schema.parse({ title: "Topic", kind: { type: "fact" }, summary: "s", detail: "d", confidence: "high", facets: {}, properties: {}, proposedRelations: [] });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  const drop = (topic: string, extra = "", domain: string | null = "wp") =>
    writeFileSync(join(inbox(), `${topic}.md`), `---\nfrom: w1\nden_topic_id: ${topic}\ncontent_hash: c0de${(++n).toString(16)}\nprev_hash: null\n${domain ? `domain_hint: ${domain}\n` : ""}${extra}---\n\n# ${topic}\n\nbody ${n}\n`);
  const run = (scores: Record<string, number> = {}) =>
    sweep({
      engine, roots, notify: () => {}, onEvent: (e) => events.push(e),
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () => Object.entries(scores).map(([entryId, s]) => ({ entryId, domain: "wp", vector: at(s) })) as never,
    });

  beforeEach(() => {
    events = [];
    n = 0;
    base = mkdtempSync(join(tmpdir(), "kb-events-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(entries(), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  it("create: started (pending) then an item carrying the entry id", async () => {
    drop("alpha");
    drop("beta");
    await run();
    expect(events).toEqual([
      { type: "started", pending: 2 },
      { type: "item", from: "w1", denTopicId: "alpha", outcome: "create", entryId: expect.stringMatching(/^kb-wp-/) },
    ]);
  });

  it("merge: a changed contribution of a known den topic merges into its entry", async () => {
    drop("alpha");
    await run();
    const created = events.find((e) => e.type === "item") as Extract<SweepEvent, { type: "item" }>;
    events.length = 0;
    drop("alpha");
    await run({ [created.entryId!]: 0.9 });
    expect(events).toEqual([
      { type: "started", pending: 1 },
      { type: "item", from: "w1", denTopicId: "alpha", outcome: "merge", entryId: created.entryId },
    ]);
  });

  it("reject: an archived contribution older than the live entry", async () => {
    writeFileSync(join(entries(), "kb-wp-AAAAAAA.md"), "---\nid: kb-wp-AAAAAAA\ntitle: T\nsummary: S\nsection: sec-wp-aaaaaa\ncreated: 2025-01-02\nupdated: 2026-10-01\n---\n\nbody\n");
    drop("old", "currency: archived\nsource_updated: 2025-01-01\n");
    await run({ "kb-wp-AAAAAAA": 0.97 });
    expect(events).toEqual([
      { type: "started", pending: 1 },
      { type: "item", from: "w1", denTopicId: "old", outcome: "reject" },
    ]);
  });

  it("parked: an unretryable contribution (no domain) parks at once", async () => {
    drop("nodomain", "", null);
    await run();
    expect(events).toEqual([
      { type: "started", pending: 1 },
      { type: "item", from: "w1", denTopicId: "nodomain", outcome: "parked" },
    ]);
  });

  it("unclassified (undeclared domain): started, but no item (it appears only as a receipt)", async () => {
    writeFileSync(join(roots.kbBase, "domains.yaml"), "domains:\n  wp: {}\n");
    drop("odd", "", "ghost");
    const r = await run();
    expect(r.unclassified).toBe(1);
    expect(events).toEqual([{ type: "started", pending: 1 }]);
  });

  it("an empty inbox emits nothing", async () => {
    await run();
    expect(events).toEqual([]);
  });

  it("a throwing callback never breaks the sweep", async () => {
    drop("alpha");
    const r = await sweep({
      engine, roots, notify: () => {}, onEvent: () => { throw new Error("subscriber bug"); },
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }), loadEntryVectors: async () => [],
    });
    expect(r.created).toBe(1);
  });
});
