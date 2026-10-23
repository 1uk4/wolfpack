import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { resolveAliasedEntry } from "./alias.js";
import { appendLedger } from "./ledger.js";
import { ev } from "../shared/index.js";
import type { KbRoots } from "../shared/index.js";

const at = (score: number): number[] => [score, Math.sqrt(1 - score * score), 0];

describe("sweep: routing decisions", () => {
  let base: string;
  let roots: KbRoots;
  const notes: string[] = [];
  const calls: Array<{ step: string; prompt: string }> = [];
  let subjectAnswer: (prompt: string) => unknown;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = (d: string) => join(roots.kbBase, "domains", d, "entries");
  const receiptText = () => {
    const dir = join(roots.opsRoot, "receipts", "w1");
    return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf-8")).join("\n");
  };
  const routingOf = () => JSON.parse(/^routing: (.*)$/m.exec(receiptText())![1]);

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
      calls.push({ step, prompt: opts.prompt });
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      if (step === "matchSubject") return schema.parse(subjectAnswer(opts.prompt));
      return schema.parse({
        title: "Topic", kind: { type: "fact" }, summary: "s", detail: "d",
        confidence: "high", facets: {}, properties: {}, proposedRelations: [],
      });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  const entry = (domain: string, id: string) => {
    mkdirSync(entries(domain), { recursive: true });
    writeFileSync(
      join(entries(domain), `${id}.md`),
      `---\nid: ${id}\ntitle: Title ${id}\nsummary: Summary of ${id}\nsection: sec-${domain}-aaaaaa\ncreated: 2025-01-02\n---\n\nbody\n`
    );
  };
  const drop = (domain: string, extra = "", topic = "some-topic", hash = "c0de") =>
    writeFileSync(join(inbox(), `${topic}.md`), `---\nfrom: w1\nden_topic_id: ${topic}\ncontent_hash: ${hash}\nprev_hash: null\ndomain_hint: ${domain}\n${extra}---\n\n# A title\n\nbody\n`);
  const run = (vectors: Array<{ entryId: string; domain: string; score: number }>) =>
    sweep({
      engine, roots, notify: (m) => notes.push(m),
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () => vectors.map((v) => ({ entryId: v.entryId, domain: v.domain, vector: at(v.score) })) as any,
    });

  beforeEach(() => {
    notes.length = 0;
    calls.length = 0;
    subjectAnswer = () => ({ match: "new", reason: "different" });
    base = mkdtempSync(join(tmpdir(), "kb-routing-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(join(roots.opsRoot, "ledger"), { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("an alias into another domain merges into that entry (not a new entry)", async () => {
    entry("wp", "kb-wp-AAAAAAA");
    mkdirSync(entries("sj"), { recursive: true });
    appendLedger(roots, [
      ev.entryWritten("kb-wp-AAAAAAA", "kb-wp-AAAAAAA", "create"),
      ev.aliased("w1", "some-topic", "kb-wp-AAAAAAA", "old"),
    ]);
    drop("sj");
    const res = await run([]);
    expect(res.errors).toBe(0);
    expect(res.merged).toBe(1);
    expect(res.created).toBe(0);
    expect(readdirSync(entries("sj"))).toHaveLength(0);
    expect(readFileSync(join(entries("wp"), "kb-wp-AAAAAAA.md"), "utf-8")).toContain("id: kb-wp-AAAAAAA");
    expect(notes.some((n) => n.includes("is in domain wp, contribution says sj"))).toBe(true);
    const r = routingOf();
    expect(r.route).toBe("alias");
    expect(r.target).toBe("kb-wp-AAAAAAA");
    expect(r.domainMismatch).toEqual({ hint: "sj", entry: "wp" });
  });

  it("resolveAliasedEntry follows 'merged into' to the survivor and gives up otherwise", () => {
    entry("wp", "kb-wp-BBBBBBB");
    const log = [ev.entryRetired("kb-wp-AAAAAAA", "merged into kb-wp-BBBBBBB"), ev.entryRetired("kb-wp-ZZZZZZZ", "no longer true")];
    expect(resolveAliasedEntry(roots, log, "kb-wp-AAAAAAA", "wp")).toEqual({ id: "kb-wp-BBBBBBB", domain: "wp", followedFrom: "kb-wp-AAAAAAA" });
    expect(resolveAliasedEntry(roots, log, "kb-wp-ZZZZZZZ", "wp")).toBeNull();
  });

  it("records the candidates, band and subject answer in the receipt", async () => {
    entry("wp", "kb-wp-AAAAAAA");
    entry("wp", "kb-wp-CCCCCCC");
    subjectAnswer = () => ({ match: "kb-wp-AAAAAAA", reason: "same system" });
    drop("wp");
    await run([
      { entryId: "kb-wp-AAAAAAA", domain: "wp", score: 0.8 },
      { entryId: "kb-wp-CCCCCCC", domain: "wp", score: 0.7 },
    ]);
    const r = routingOf();
    expect(r.route).toBe("similarity");
    expect(r.band).toBe("ask");
    expect(r.candidates.map((c: { id: string }) => c.id)).toEqual(["kb-wp-AAAAAAA", "kb-wp-CCCCCCC"]);
    expect(r.candidates[0].score).toBeCloseTo(0.8, 2);
    expect(r.subject).toEqual({ match: "kb-wp-AAAAAAA", valid: true, reason: "same system" });
    expect(receiptText()).toMatch(/outcome: merge/);
  });

  it("a target hint leads the subject check and is not a bypass", async () => {
    entry("wp", "kb-wp-AAAAAAA");
    entry("wp", "kb-wp-CCCCCCC");
    subjectAnswer = (p) => ({ match: p.indexOf("kb-wp-CCCCCCC") < p.indexOf("kb-wp-AAAAAAA") ? "kb-wp-CCCCCCC" : "new" });
    drop("wp", "target: kb-wp-CCCCCCC\n");
    // the hinted entry scores LOW (below mergeLow): without the hint nothing would be asked
    const res = await run([
      { entryId: "kb-wp-AAAAAAA", domain: "wp", score: 0.5 },
      { entryId: "kb-wp-CCCCCCC", domain: "wp", score: 0.3 },
    ]);
    expect(res.merged).toBe(1);
    expect(calls.filter((c) => c.step === "matchSubject")).toHaveLength(1);
    expect(routingOf().targetHint).toBe("kb-wp-CCCCCCC");
    expect(routingOf().target).toBe("kb-wp-CCCCCCC");
  });

  it("a target hint the subject check rejects creates a new entry", async () => {
    entry("wp", "kb-wp-CCCCCCC");
    subjectAnswer = () => ({ match: "new", reason: "not it" });
    drop("wp", "target: kb-wp-CCCCCCC\n");
    const res = await run([{ entryId: "kb-wp-CCCCCCC", domain: "wp", score: 0.3 }]);
    expect(res.created).toBe(1);
    expect(routingOf().route).toBe("new");
  });
});
