/** One `decision` ledger event per contribution outcome (work-wolfpack-55ZPU2a), plus old ledgers (no decision events) still reading. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep, type SweepEvent } from "./sweep.js";
import { readLedger, seenHashes, foldRegistry } from "./ledger.js";
import { recordFailure, recordOverrun } from "./park.js";
import { defaultSweepWriter, type SweepWriter } from "./sweep-writer.js";
import { SWEEP } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";
import { ledgerFile } from "../shared/index.js";

const at = (score: number): number[] => [score, Math.sqrt(1 - score * score), 0];

describe("sweep decision events", () => {
  let base: string;
  let roots: KbRoots;
  let events: SweepEvent[];
  let n = 0;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = () => join(roots.kbBase, "domains", "wp", "entries");
  const decisions = () => readLedger(roots).filter((e) => e.t === "decision") as Array<Extract<ReturnType<typeof readLedger>[number], { t: "decision" }>>;

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      return schema.parse({ title: "Topic", kind: { type: "fact" }, summary: "s", detail: "d", confidence: "high", facets: {}, properties: {}, proposedRelations: [] });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  const drop = (topic: string, extra = "", domain: string | null = "wp", body = `body ${n + 1}`) =>
    writeFileSync(join(inbox(), `${topic}-${++n}.md`), `---\nfrom: w1\nden_topic_id: ${topic}\ncontent_hash: c0de${n.toString(16)}\nprev_hash: null\n${domain ? `domain_hint: ${domain}\n` : ""}${extra}---\n\n# ${topic}\n\n${body}\n`);
  const run = (scores: Record<string, number> = {}) =>
    sweep({
      engine, roots, notify: () => {}, onEvent: (e) => events.push(e),
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () => Object.entries(scores).map(([entryId, s]) => ({ entryId, domain: "wp", vector: at(s) })) as never,
    });

  beforeEach(() => {
    events = [];
    n = 0;
    base = mkdtempSync(join(tmpdir(), "kb-decisions-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(entries(), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  const item = () => events.filter((e): e is Extract<SweepEvent, { type: "item" }> => e.type === "item");

  it("create: one decision, in the batch with the contribution event, carrying the routing", async () => {
    drop("alpha");
    await run();
    const d = decisions();
    expect(d).toHaveLength(1);
    const id = item()[0].entryId!;
    expect(d[0]).toMatchObject({ from: "w1", denTopicId: "alpha", outcome: "create", entryId: id, routing: { route: "new", candidates: [], band: "create", target: id } });
    expect(d[0].hash).toBe("c0de1");
    const log = readLedger(roots);
    const i = log.findIndex((e) => e.t === "decision");
    expect(log[i - 1].t).toBe("contribution");
    expect(item()[0].decision).toEqual({ outcome: "create", entryId: id, routing: d[0].routing });
    // the entry_written count is untouched: still one per entry
    expect(log.filter((e) => e.t === "entry_written")).toHaveLength(1);
  });

  it("merge: candidates with scores, band and target", async () => {
    drop("alpha");
    await run();
    const id = item()[0].entryId!;
    events.length = 0;
    drop("alpha");
    await run({ [id]: 0.9 });
    const d = decisions();
    expect(d).toHaveLength(2);
    expect(d[1]).toMatchObject({ outcome: "merge", entryId: id, routing: { route: "alias", target: id } });
    expect(item()[0].decision).toMatchObject({ outcome: "merge", entryId: id });
  });

  it("unchanged: a verbatim anchored re-send with the same text", async () => {
    const hub = "work-wp-INITI01";
    drop(hub, `anchor: ${hub}\nverbatim: true\n`, "wp", "same body");
    await run();
    events.length = 0;
    drop(hub, `anchor: ${hub}\nverbatim: true\n`, "wp", "same body");
    await run();
    const d = decisions();
    expect(d.map((x) => x.outcome)).toEqual(["create", "unchanged"]);
    expect(d[1]).toMatchObject({ entryId: d[0].entryId, routing: { route: "anchor", target: d[0].entryId } });
    expect(item()[0].outcome).toBe("merge"); // sweep_item keeps its four outcomes; the decision says `unchanged`
    expect(item()[0].decision?.outcome).toBe("unchanged");
  });

  it("reject: decision with the reason and routing, no contribution event", async () => {
    writeFileSync(join(entries(), "kb-wp-AAAAAAA.md"), "---\nid: kb-wp-AAAAAAA\ntitle: T\nsummary: S\nsection: sec-wp-aaaaaa\ncreated: 2025-01-02\nupdated: 2026-10-01\n---\n\nbody\n");
    drop("old", "currency: archived\nsource_updated: 2025-01-01\n");
    await run({ "kb-wp-AAAAAAA": 0.97 });
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ outcome: "reject", denTopicId: "old", reason: "archived-older-than-live: 2025-01-01 < 2026-10-01", routing: { route: expect.any(String), candidates: expect.any(Array) } });
    expect(readLedger(roots).filter((e) => e.t === "contribution")).toHaveLength(0);
    expect(item()[0].decision).toMatchObject({ outcome: "reject" });
  });

  it("parked: decision with the reason (no domain)", async () => {
    drop("nodomain", "", null);
    await run();
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ outcome: "parked", denTopicId: "nodomain", reason: "unclassified: no domain" });
    expect(item()[0].decision).toMatchObject({ outcome: "parked", reason: "unclassified: no domain" });
  });

  it("unclassified (undeclared domain): decision, and still no sweep_item", async () => {
    writeFileSync(join(roots.kbBase, "domains.yaml"), "domains:\n  wp: {}\n");
    drop("odd", "", "ghost");
    const r = await run();
    expect(r.unclassified).toBe(1);
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ outcome: "unclassified", denTopicId: "odd", reason: "pending domain: ghost" });
    expect(item()).toHaveLength(0);
  });

  it("a failing decision append on the reject path does not fail the item", async () => {
    writeFileSync(join(entries(), "kb-wp-AAAAAAA.md"), "---\nid: kb-wp-AAAAAAA\ntitle: T\nsummary: S\nsection: sec-wp-aaaaaa\ncreated: 2025-01-02\nupdated: 2026-10-01\n---\n\nbody\n");
    drop("old", "currency: archived\nsource_updated: 2025-01-01\n");
    const { defaultSweepWriter } = await import("./sweep-writer.js");
    const r = await sweep({
      engine, roots, notify: () => {}, onEvent: (e) => events.push(e),
      writer: { ...defaultSweepWriter, appendLedger: () => { throw new Error("disk full"); } },
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () => [{ entryId: "kb-wp-AAAAAAA", domain: "wp", vector: at(0.97) }] as never,
    });
    expect(r.rejected).toBe(1);
    expect(r.errors).toBe(0);
  });

  const runW = (over: Partial<Parameters<typeof sweep>[0]>) =>
    sweep({
      engine, roots, notify: () => {}, onEvent: (e) => events.push(e),
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () => [],
      ...over,
    });
  const failing = (over: Partial<SweepWriter>): SweepWriter => ({ ...defaultSweepWriter, ...over });
  const seed = (hash: string, kind: "attempts" | "overruns") => {
    const c = { contentHash: hash } as never;
    if (kind === "attempts") for (let i = 1; i < SWEEP.maxAttempts; i++) recordFailure(roots, c, "earlier failure");
    else for (let i = 1; i <= SWEEP.budgetRetries; i++) recordOverrun(roots, c, "earlier overrun");
  };

  it("an item that errors AFTER its create batch and is then parked keeps exactly one decision (the create)", async () => {
    drop("alpha");
    seed("c0de1", "attempts");
    const r = await runW({ writer: failing({ writeReceipt: () => { throw new Error("receipt disk full"); } }) });
    expect(r.parked).toHaveLength(1);
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ outcome: "create", denTopicId: "alpha" });
    expect(item()[0]).toMatchObject({ outcome: "parked" }); // sweep_item behaviour is unchanged
  });

  it("parked after retries are exhausted: decision with the reason and the routing the item had reached", async () => {
    drop("alpha");
    seed("c0de1", "attempts");
    const bad = { call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      throw new Error("model returned junk");
    }, usage: { summarize: () => ({}) } } as unknown as Engine;
    const r = await runW({ engine: bad });
    expect(r.parked).toHaveLength(1);
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ outcome: "parked", reason: `failed ${SWEEP.maxAttempts} times: model returned junk`, routing: { route: "new", candidates: [], band: "create" } });
    expect(item()[0].decision).toEqual({ outcome: "parked", reason: d[0].reason, routing: d[0].routing });
  });

  it("parked after a budget overrun: decision with the reason and routing", async () => {
    drop("alpha");
    seed("c0de1", "overruns");
    const hang = { call: async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { signal?: AbortSignal }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      return new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal!.reason), { once: true }));
    }, usage: { summarize: () => ({}) } } as unknown as Engine;
    const r = await runW({ engine: hang, budgetMs: 100 });
    expect(r.parked).toHaveLength(1);
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ outcome: "parked", reason: expect.stringMatching(/time budget \(2 times\)/), routing: { route: "new", band: "create" } });
  });

  it("a failing decision append on the parked path does not fail the item", async () => {
    drop("nodomain", "", null);
    const r = await runW({ writer: failing({ appendLedger: () => { throw new Error("disk full"); } }) });
    expect(r.parked).toHaveLength(1);
    expect(r.errors).toBe(1); // the park itself is the item error it always was
    expect(decisions()).toHaveLength(0);
    expect(item()[0].outcome).toBe("parked");
  });

  it("a failing decision append on the unclassified path does not fail the item", async () => {
    writeFileSync(join(roots.kbBase, "domains.yaml"), "domains:\n  wp: {}\n");
    drop("odd", "", "ghost");
    const r = await runW({ writer: failing({ appendLedger: () => { throw new Error("disk full"); } }) });
    expect(r.unclassified).toBe(1);
    expect(r.errors).toBe(0);
    expect(decisions()).toHaveLength(0);
  });

  it("the duplicate path (hash already seen) emits no decision", async () => {
    drop("alpha");
    await run();
    expect(decisions()).toHaveLength(1);
    // same file again (same hash): retired as a duplicate
    writeFileSync(join(inbox(), "again.md"), `---\nfrom: w1\nden_topic_id: alpha\ncontent_hash: c0de1\nprev_hash: null\ndomain_hint: wp\n---\n\n# alpha\n\nbody 1\n`);
    await run();
    expect(decisions()).toHaveLength(1);
  });

  describe("old ledgers", () => {
    it("a ledger with no decision events reads, folds and dedupes as before; a mixed ledger too", () => {
      const old = [
        { id: "a1", at: "2026-01-01T00:00:00Z", t: "contribution", from: "w1", denTopicId: "t", hash: "sha256:aa", prevHash: null, domainHint: "wp" },
        { id: "a2", at: "2026-01-01T00:00:00Z", t: "entry_written", entryId: "kb-wp-1", canonicalId: "kb-wp-1", action: "create" },
        { id: "a3", at: "2026-01-01T00:00:00Z", t: "aliased", wolf: "w1", denTopicId: "t", canonicalId: "kb-wp-1", hash: "sha256:aa" },
        { id: "a4", at: "2026-01-01T00:00:00Z", t: "routed", contribution: "a1", kind: "create" },
        { id: "a5", at: "2026-01-01T00:00:00Z", t: "rejected", contribution: "a1", reason: "x" },
      ];
      mkdirSync(join(roots.denLocal, "ledger"), { recursive: true });
      writeFileSync(ledgerFile(roots), old.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const log = readLedger(roots);
      expect(log).toHaveLength(5);
      expect(seenHashes(log).has("sha256:aa")).toBe(true);
      expect(foldRegistry(log).get("kb-wp-1")?.entries).toEqual(["kb-wp-1"]);
      // appending a decision to it keeps everything readable
      writeFileSync(ledgerFile(roots), readFileSync(ledgerFile(roots), "utf8") + JSON.stringify({ id: "a6", at: "2026-01-01T00:00:00Z", t: "decision", from: "w1", denTopicId: "t", hash: "sha256:bb", outcome: "reject", reason: "r" }) + "\n");
      const mixed = readLedger(roots);
      expect(mixed).toHaveLength(6);
      expect(seenHashes(mixed).has("sha256:bb")).toBe(false); // a decision never marks a hash as seen
      expect(foldRegistry(mixed).get("kb-wp-1")?.entries).toEqual(["kb-wp-1"]);
    });
  });
});
