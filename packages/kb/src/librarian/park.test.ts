import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { withBudget, BudgetExceeded, unpark, listParked } from "./park.js";
import type { KbRoots } from "../shared/index.js";

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
      `---\nfrom: w1\nden_topic_id: ${name}\nchange: create\ncontent_hash: h-${name}\nprev_hash: null\ndomain_hint: wp\nsubmitted: ${submitted}\n---\n\n# ${name}\n\n${body}\n`
    );

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-park-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(join(roots.kbBase, "domains", "wp", "entries"), { recursive: true });
    vi.stubEnv("KB_SWEEP_ITEM_BUDGET_MS", "200");
    // Fake Ollama: every text embeds to the same unit vector.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  const run = (engine: Engine) =>
    sweep({ engine, roots, loadEntryVectors: async () => [], notify: () => {} });

  it("parks an item that runs over its budget and still processes the next one", async () => {
    drop("slow", "HANG on purpose", "2026-10-10T01:00:00Z");
    drop("fine", "the second one", "2026-10-10T02:00:00Z");

    const r = await run(fakeEngine());

    expect(r.parked).toEqual([{ from: "w1", denTopicId: "slow", reason: "over its 0s time budget" }]);
    expect(r.created).toBe(1);
    expect(readdirSync(inbox()).filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(listParked(roots)).toEqual([{ wolf: "w1", file: "slow.md" }]);
    const receipt = readFileSync(join(roots.opsRoot, "receipts", "w1", readdirSync(join(roots.opsRoot, "receipts", "w1")).find((f) => f.startsWith("slow"))!), "utf8");
    expect(receipt).toContain("outcome: parked");
    expect(receipt).toContain("wolfpack-kb unpark w1/slow.md");
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
