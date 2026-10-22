import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  const tick = () => runSweepTick({ roots, createEngine, notify: () => {}, alert: (m) => void alerts.push(m), budgetMs: 1000 });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-tick-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(join(roots.kbBase, "domains", "wp", "entries"), { recursive: true });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] })));
    vi.stubGlobal("fetch", fetchMock);
    mode = "ok";
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

  it("sweeps one item (oldest first) with one engine, then reorgs only the touched domains with the tick's embedder", async () => {
    drop("newer", "2026-10-10T02:00:00Z");
    drop("older", "2026-10-10T01:00:00Z");
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

  it("compacts the vector cache after a reorg, dropping vectors of entries that no longer exist", async () => {
    const dir = vectorsDir(roots);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ model: EMBED.model, dim: 3, updated: "x" }));
    writeFileSync(join(dir, "cache.jsonl"), JSON.stringify({ hash: "sha256:gone", vec: [0, 1, 0] }) + "\n");
    drop("a");
    await tick();
    expect(reorgCalls).toHaveLength(1);
    expect(readFileSync(join(dir, "cache.jsonl"), "utf-8")).not.toContain("sha256:gone");
  });
});
