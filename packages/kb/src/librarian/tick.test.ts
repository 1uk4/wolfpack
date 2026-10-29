import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { EMBED } from "@wolfpack/engine";
import { runSweepTick } from "./tick.js";
import { appendLedger } from "./ledger.js";
import { noteInfraFailure, readBackoff } from "./backoff.js";
import { ev, vectorsDir, type KbRoots } from "../shared/index.js";

const reorgCalls = vi.hoisted(() => [] as Array<{ domains?: string[]; embedder?: unknown }>);
vi.mock("./reorg.js", () => ({
  reorg: vi.fn(async (opts: { domains?: string[]; embedder?: unknown }) => {
    reorgCalls.push({ domains: opts.domains, embedder: opts.embedder });
    return { splits: 0, merges: 0, crystallized: 0, placements: 0, labelsUpdated: 0, domains: opts.domains ?? [] };
  }),
}));

const opinion = (title: string) => ({
  title,
  kind: { type: "fact" },
  summary: `${title} summary`,
  detail: `${title} detail`,
  confidence: "high",
  facets: {},
  properties: {},
  proposedRelations: [],
});

describe("runSweepTick", () => {
  let base: string;
  let roots: KbRoots;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const hashOf = (name: string) => Buffer.from(name).toString("hex");
  const drop = (name: string, submitted = "2026-10-10T01:00:00Z") =>
    writeFileSync(
      join(inbox(), `${name}.md`),
      `---\nfrom: w1\nden_topic_id: ${name}\nchange: create\ncontent_hash: ${hashOf(name)}\nprev_hash: null\ndomain_hint: wp\nsubmitted: ${submitted}\n---\n\n# ${name}\n\n${name} body\n`
    );
  const queued = () => readdirSync(inbox()).filter((f) => f.endsWith(".md")).sort();

  let mode: "ok" | "junk";
  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      if (mode === "junk") throw new Error("model returned junk");
      return schema.parse(opinion("First"));
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;
  const createEngine = vi.fn(() => engine);
  const alerts: string[] = [];
  let reorgOn = false;
  const tick = () => runSweepTick({ roots, postSweepReorg: reorgOn, createEngine, notify: () => {}, alert: (m) => void alerts.push(m), budgetMs: 1000 });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-tick-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(join(roots.kbBase, "domains", "wp", "entries"), { recursive: true });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] })));
    vi.stubGlobal("fetch", fetchMock);
    mode = "ok";
    reorgOn = false;
    alerts.length = 0;
    reorgCalls.length = 0;
    createEngine.mockClear();
    createEngine.mockImplementation(() => engine);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  it("an empty inbox is idle: no engine, no embedder, no cache or ledger", async () => {
    const t = await tick();
    expect(t.outcome).toBe("idle");
    expect(createEngine).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(vectorsDir(roots))).toBe(false);
    expect(existsSync(join(roots.denLocal, "ledger.jsonl"))).toBe(false);
  });

  it("skips the tick inside a backoff window without building an engine", async () => {
    drop("a");
    await noteInfraFailure(roots, new Error("Overloaded"));
    const t = await tick();
    expect(t.outcome).toBe("backoff");
    expect(t.sweep.paused).toMatch(/backing off/);
    expect(createEngine).not.toHaveBeenCalled();
    expect(queued()).toEqual(["a.md"]);
  });

  it("retires an already-seen duplicate without loading vectors", async () => {
    drop("dup");
    appendLedger(roots, [ev.contribution({ from: "w1", denTopicId: "dup", hash: hashOf("dup"), prevHash: null, domainHint: "wp" })]);
    const t = await tick();
    expect(t.outcome).toBe("ran");
    expect(t.sweep.processed).toBe(0);
    expect(queued()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(vectorsDir(roots))).toBe(false);
    expect(reorgCalls).toEqual([]);
  });

  it("does not reorg by default: the sweep only places the new entry", async () => {
    drop("a");
    const t = await tick();
    expect(t.sweep).toMatchObject({ processed: 1, created: 1 });
    expect(reorgCalls).toEqual([]);
    expect(t.reorg).toBeUndefined();
    expect(readdirSync(join(roots.kbBase, "domains", "wp", "entries")).length).toBe(1);
  });

  it("WOLFPACK_KB_POST_SWEEP_REORG=1 enables the reorg when the option is unset", async () => {
    vi.stubEnv("WOLFPACK_KB_POST_SWEEP_REORG", "1");
    try {
      drop("a");
      const t = await runSweepTick({ roots, createEngine, notify: () => {}, budgetMs: 1000 });
      expect(reorgCalls).toHaveLength(1);
      expect(t.reorg).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sweeps one item (oldest first) with one engine, then (reorg on) reorgs only the touched domains with the tick's embedder", async () => {
    drop("newer", "2026-10-10T02:00:00Z");
    drop("older", "2026-10-10T01:00:00Z");
    reorgOn = true;
    const t = await tick();
    expect(t.sweep).toMatchObject({ processed: 1, created: 1, remaining: 1, touchedDomains: ["wp"] });
    expect(queued()).toEqual(["newer.md"]);
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(reorgCalls).toHaveLength(1);
    expect(reorgCalls[0].domains).toEqual(["wp"]);
    expect(reorgCalls[0].embedder).toBeDefined();
    expect(t.reorg).toBeDefined();
  });

  it("does not reorg when the item was not committed", async () => {
    drop("a");
    mode = "junk";
    const t = await tick();
    expect(t.sweep).toMatchObject({ created: 0, merged: 0, errors: 1 });
    expect(reorgCalls).toEqual([]);
  });

  it("compacts a bloated cache without a reorg", async () => {
    const dir = vectorsDir(roots);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ model: EMBED.model, dim: 3, updated: "x" }));
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ hash: `sha256:gone${i}`, vec: [0, 1, 0] })).join("\n") + "\n";
    writeFileSync(join(dir, "cache.jsonl"), lines);
    drop("a");
    await tick();
    expect(reorgCalls).toEqual([]);
    expect(readFileSync(join(dir, "cache.jsonl"), "utf-8")).not.toContain("sha256:gone0");
  });

  it("finishes an interrupted rebuild (journal left behind) before anything else, even with an empty inbox", async () => {
    const final = join(roots.kbBase, "domains", "wp", "entries", "a.md");
    writeFileSync(final, "---\ndomain: wp\nsection: old\n---\n");
    mkdirSync(roots.denLocal, { recursive: true });
    writeFileSync(join(roots.denLocal, ".rebuild-journal.json"), JSON.stringify({ version: 3, domain: "wp", at: "x", entries: [{ path: final, section: "sec-wp-new" }], renames: [] }));
    const t = await tick();
    expect(t.outcome).toBe("idle");
    expect(readFileSync(final, "utf-8")).toContain("section: sec-wp-new");
    expect(existsSync(join(roots.denLocal, ".rebuild-journal.json"))).toBe(false);
  });

  const badJournal = () => {
    const tmp = join(roots.denLocal, "stale.tmp");
    mkdirSync(roots.denLocal, { recursive: true });
    writeFileSync(tmp, "x");
    // renaming into a directory that does not exist throws ENOENT on every attempt
    writeFileSync(join(roots.denLocal, ".rebuild-journal.json"), JSON.stringify({ version: 3, domain: "wp", at: "x", entries: [], renames: [{ tmp, final: join(base, "no", "such", "dir", "f") }] }));
  };

  it("while a journal is present and recovery fails the run is SKIPPED (paused), counted once per run, and quarantined after 3 runs", async () => {
    badJournal();
    drop("a");
    const notes: string[] = [];
    const run = () => runSweepTick({ roots, createEngine, notify: (m) => notes.push(m), budgetMs: 1000 });
    for (let i = 1; i <= 2; i++) {
      const t = await run();
      expect(t.outcome).toBe("backoff");
      expect(t.sweep.paused).toMatch(new RegExp(`\\(${i}/3\\)`));
      expect(t.sweep.processed).toBe(0);
      expect(t.sweep.remaining).toBe(1); // the item waits; nothing was placed
      expect(queued()).toEqual(["a.md"]);
      expect(createEngine).not.toHaveBeenCalled();
      expect(existsSync(join(roots.denLocal, ".rebuild-journal.json"))).toBe(true);
      expect(notes.at(-1)).toMatch(new RegExp(`failed \\(${i}/3\\).*skipped`));
    }
    // a 3rd failed run with a YOUNG journal is skipped but not quarantined (it waits for the journal to be 10 minutes old)
    const young = await run();
    expect(young.outcome).toBe("backoff");
    expect(existsSync(join(roots.denLocal, ".rebuild-journal.json"))).toBe(true);
    expect(young.sweep.paused).toMatch(/\(3\/3\)/);
    expect(notes.at(-1)).toMatch(/10 minutes old/);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(join(roots.denLocal, ".rebuild-journal.json"), old, old);
    // the next failed run quarantines the journal and is itself skipped
    const third = await run();
    expect(third.outcome).toBe("backoff");
    expect(third.sweep.paused).toMatch(/quarantined/);
    expect(existsSync(join(roots.denLocal, ".rebuild-journal.json"))).toBe(false);
    expect(existsSync(join(roots.denLocal, ".rebuild-journal.bad"))).toBe(true);
    expect(third.sweep.journalBad).toMatch(/quarantined rebuild journal/);
    expect(queued()).toEqual(["a.md"]);
    // the next run proceeds, and keeps reporting the .bad file until an operator removes it
    const next = await run();
    expect(next.outcome).toBe("ran");
    expect(next.sweep).toMatchObject({ processed: 1, created: 1 });
    expect(next.sweep.journalBad).toMatch(/\.rebuild-journal\.bad/);
    rmSync(join(roots.denLocal, ".rebuild-journal.bad"));
    drop("b");
    expect((await run()).sweep.journalBad).toBeUndefined();
  });

  it("sweep() entered directly (no tick) also skips while recovery fails, and counts one attempt per call", async () => {
    badJournal();
    drop("a");
    const { sweep } = await import("./sweep.js");
    const notes: string[] = [];
    const r = await sweep({ engine: { call: vi.fn(), usage: { summarize: () => ({}) } } as unknown as Engine, roots, loadEntryVectors: async () => [], notify: (m) => notes.push(m) });
    expect(r.paused).toMatch(/\(1\/3\)/);
    expect(r.processed).toBe(0);
    expect(queued()).toEqual(["a.md"]);
    expect(readFileSync(join(roots.denLocal, ".rebuild-recover-failures"), "utf-8")).toBe("1");
  });

  it("an unreadable journal is quarantined at once and the run is skipped with the .bad note", async () => {
    mkdirSync(roots.denLocal, { recursive: true });
    writeFileSync(join(roots.denLocal, ".rebuild-journal.json"), "{ not json");
    drop("a");
    const t = await tick();
    expect(t.outcome).toBe("backoff");
    expect(t.sweep.journalBad).toBeDefined();
    expect(existsSync(join(roots.denLocal, ".rebuild-journal.bad"))).toBe(true);
    expect(queued()).toEqual(["a.md"]);
  });

  it("an infra error outside sweep (engine setup) enters backoff, alerts once, and keeps the item", async () => {
    drop("a");
    createEngine.mockImplementation(() => {
      throw Object.assign(new Error("Overloaded"), { status: 529 });
    });
    const t = await tick();
    expect(t.outcome).toBe("backoff");
    expect(t.sweep.paused).toMatch(/Overloaded/);
    expect(readBackoff(roots)).toMatchObject({ consecutive: 1 });
    expect(alerts).toEqual(["sweep paused: Overloaded, retrying with backoff"]);
    expect(queued()).toEqual(["a.md"]);

    // The next tick is inside the window: skipped before the engine is built.
    createEngine.mockClear();
    expect((await tick()).outcome).toBe("backoff");
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("a non-infra error outside sweep is thrown and sets no backoff", async () => {
    drop("a");
    createEngine.mockImplementation(() => {
      throw new Error("models.json is missing");
    });
    await expect(tick()).rejects.toThrow(/models.json is missing/);
    expect(readBackoff(roots)).toBeNull();
  });

  it("compacts the vector cache (reorg on), dropping vectors of entries that no longer exist", async () => {
    const dir = vectorsDir(roots);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ model: EMBED.model, dim: 3, updated: "x" }));
    writeFileSync(join(dir, "cache.jsonl"), JSON.stringify({ hash: "sha256:gone", vec: [0, 1, 0] }) + "\n");
    drop("a");
    reorgOn = true;
    await tick();
    expect(reorgCalls).toHaveLength(1);
    expect(readFileSync(join(dir, "cache.jsonl"), "utf-8")).not.toContain("sha256:gone");
  });
});
