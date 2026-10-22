import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { withBudget, BudgetExceeded, unpark, listParked, recordFailure } from "./park.js";
import type { KbRoots, ParsedContribution } from "../shared/index.js";

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

/** Fake engine: "hang" contributions never answer unless their signal aborts. */
function fakeEngine(): Engine {
  return {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string; signal?: AbortSignal }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      if (opts.prompt.includes("HANG")) {
        return new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(opts.signal!.reason), { once: true });
        });
      }
      if (opts.prompt.includes("BROKEN")) throw new Error("model returned junk");
      return schema.parse(opinion(opts.prompt.includes("second") ? "Second" : "First"));
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;
}

describe("withBudget", () => {
  it("rejects at the deadline and aborts the signal, even if fn ignores it", async () => {
    let signal: AbortSignal | undefined;
    const p = withBudget(30, (s) => {
      signal = s;
      return new Promise(() => {}); // never settles
    });
    await expect(p).rejects.toBeInstanceOf(BudgetExceeded);
    expect(signal?.aborted).toBe(true);
  });

  it("passes through a result in time", async () => {
    await expect(withBudget(1000, async () => 42)).resolves.toBe(42);
  });
});

describe("sweep: one bad contribution never blocks the queue", () => {
  let base: string;
  let roots: KbRoots;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const drop = (name: string, body: string, submitted: string) =>
    writeFileSync(
      join(inbox(), `${name}.md`),
      `---\nfrom: w1\nden_topic_id: ${name}\nchange: create\ncontent_hash: ${Buffer.from(name).toString("hex")}\nprev_hash: null\ndomain_hint: wp\nsubmitted: ${submitted}\n---\n\n# ${name}\n\n${body}\n`
    );

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-park-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(join(roots.kbBase, "domains", "wp", "entries"), { recursive: true });
    // Fake Ollama: every text embeds to the same unit vector.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  const run = (engine: Engine, budgetMs = 200) =>
    sweep({ engine, roots, loadEntryVectors: async () => [], notify: () => {}, budgetMs });

  it("parks an item that runs over its budget; the next run processes the next one", async () => {
    drop("slow", "HANG on purpose", "2026-10-10T01:00:00Z");
    drop("fine", "the second one", "2026-10-10T02:00:00Z");

    // The first overrun is retried (stays in the inbox); the second parks it.
    const first = await run(fakeEngine());
    expect(first.parked).toEqual([]);
    expect(first.failures).toHaveLength(1);
    expect(readdirSync(inbox()).filter((f) => f.endsWith(".md")).sort()).toEqual(["fine.md", "slow.md"]);

    const second = await run(fakeEngine());
    expect(second.parked).toEqual([{ from: "w1", denTopicId: "slow", reason: "over its 0s time budget (2 times)" }]);
    expect(second.created).toBe(0);
    expect(second.remaining).toBe(1);
    expect(readdirSync(inbox()).filter((f) => f.endsWith(".md"))).toEqual(["fine.md"]);

    const r = await run(fakeEngine());
    expect(r.created).toBe(1);
    expect(readdirSync(inbox()).filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(listParked(roots)).toEqual([{ wolf: "w1", file: "slow.md" }]);
    const receipt = readFileSync(join(roots.opsRoot, "receipts", "w1", readdirSync(join(roots.opsRoot, "receipts", "w1")).find((f) => f.startsWith("slow"))!), "utf8");
    expect(receipt).toContain("outcome: parked");
    expect(receipt).toContain("wolfpack-kb unpark w1/slow.md");
  });

  it("processes exactly one item per run and leaves the rest pending", async () => {
    drop("a", "the first one", "2026-10-10T01:00:00Z");
    drop("b", "the second one", "2026-10-10T02:00:00Z");
    drop("c", "the second one too", "2026-10-10T03:00:00Z");

    const r = await run(fakeEngine());

    expect(r).toMatchObject({ processed: 1, created: 1, remaining: 2 });
    expect(readdirSync(inbox()).filter((f) => f.endsWith(".md")).sort()).toEqual(["b.md", "c.md"]);
  });

  it("does no work on an empty inbox", async () => {
    const engine = fakeEngine();
    const notes: string[] = [];
    const r = await sweep({ engine, roots, loadEntryVectors: async () => [], notify: (m) => notes.push(m) });

    expect(r).toMatchObject({ processed: 0, created: 0, remaining: 0 });
    expect(engine.call).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
    expect(readdirSync(roots.opsRoot)).toEqual(["inbox"]);
    // Only the lock may be touched: no ledger, sections, registry or git commit.
    expect(readdirSync(roots.denLocal).filter((f) => !f.includes("lock"))).toEqual([]);
  });

  it("retries a failing item on later ticks, then parks it after maxAttempts", async () => {
    drop("bad", "BROKEN content", "2026-10-10T01:00:00Z");
    const engine = fakeEngine();

    const first = await run(engine);
    expect(first.failures).toHaveLength(1);
    expect(first.parked).toHaveLength(0);
    expect(existsSync(join(inbox(), "bad.md"))).toBe(true);

    await run(engine);
    const third = await run(engine);
    expect(third.parked[0]).toMatchObject({ denTopicId: "bad", reason: "failed 3 times: model returned junk" });
    expect(existsSync(join(inbox(), "bad.md"))).toBe(false);
  });

  it("unpark moves items back to the inbox for the next sweep", () => {
    mkdirSync(join(roots.opsRoot, "parked", "w1"), { recursive: true });
    writeFileSync(join(roots.opsRoot, "parked", "w1", "x.md"), "x");
    expect(unpark(roots, "w1/x.md")).toEqual([{ wolf: "w1", file: "x.md" }]);
    expect(existsSync(join(inbox(), "x.md"))).toBe(true);
    expect(listParked(roots)).toEqual([]);
  });
});

describe("sweep: per-item log line and in-progress state", () => {
  it("logs route, timing and outcome per item; status file shows the current item", async () => {
    const { readCurrent, oldestInbox } = await import("./progress.js");
    const base = mkdtempSync(join(tmpdir(), "kb-prog-"));
    const roots: KbRoots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    const inbox = join(roots.opsRoot, "inbox", "w1");
    mkdirSync(inbox, { recursive: true });
    mkdirSync(join(roots.kbBase, "domains", "wp", "entries"), { recursive: true });
    writeFileSync(join(inbox, "t.md"), "---\nfrom: w1\nden_topic_id: topic-a\ncontent_hash: a1\nprev_hash: null\ndomain_hint: wp\n---\n\n# a\n\nbody\n");
    expect(oldestInbox(roots)?.file).toBe("t.md");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));

    let seenDuringProduce: unknown;
    const engine = {
      call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
        if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
        seenDuringProduce = readCurrent(roots);
        return schema.parse(opinion("Alpha"));
      }),
      usage: { summarize: () => ({}) },
    } as unknown as Engine;
    const notes: string[] = [];
    await sweep({ engine, roots, loadEntryVectors: async () => [], notify: (m) => notes.push(m) });

    expect(seenDuringProduce).toMatchObject({ from: "w1", denTopicId: "topic-a", route: expect.stringMatching(/^create entry in sec-wp-/) });
    expect(readCurrent(roots)).toBeNull();
    expect(notes.find((n) => n.startsWith("item w1/topic-a:"))).toMatch(/create entry in sec-wp-\w+ · llm \d+\.\ds · total \d+\.\ds → created kb-wp-/);
    expect(oldestInbox(roots)).toBeNull();
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });
});

describe("attempt tracking", () => {
  it("logs when sweep-attempts.json is corrupt, then rewrites it atomically", () => {
    const base = mkdtempSync(join(tmpdir(), "kb-attempts-"));
    const roots: KbRoots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(roots.denLocal, { recursive: true });
    const file = join(roots.denLocal, "sweep-attempts.json");
    writeFileSync(file, '{"torn":');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(recordFailure(roots, { contentHash: "abc1" } as ParsedContribution, "boom")).toBe(1);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/sweep-attempts\.json is unreadable/);
      expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ abc1: { attempts: 1, lastReason: "boom" } });
      expect(readdirSync(roots.denLocal)).toEqual(["sweep-attempts.json"]);
    } finally {
      warn.mockRestore();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
