import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { SWEEP } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { readLedger } from "./ledger.js";
import { classifyError, InfraError, readBackoff, backoffDelayMs, backoffRemainingMs, noteInfraFailure } from "./backoff.js";
import { createEmbedder } from "./embed.js";
import type { KbRoots } from "../shared/index.js";

// Failure injection for the ledger-ordering test (off unless set).
const inject = vi.hoisted(() => ({ renderIndex: false, markProcessed: false }));
vi.mock("./domains.js", async (orig) => {
  const m = await orig<typeof import("./domains.js")>();
  return {
    ...m,
    renderDomainIndex: (...a: Parameters<typeof m.renderDomainIndex>) => {
      if (inject.renderIndex) throw new Error("index render boom");
      return m.renderDomainIndex(...a);
    },
  };
});
vi.mock("./commit.js", async (orig) => {
  const m = await orig<typeof import("./commit.js")>();
  return {
    ...m,
    markProcessed: (...a: Parameters<typeof m.markProcessed>) => {
      if (inject.markProcessed) throw new Error("markProcessed boom");
      return m.markProcessed(...a);
    },
  };
});

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

describe("classifyError", () => {
  it("treats outages and auth failures as infra", () => {
    for (const e of [
      new InfraError("Ollama down"),
      Object.assign(new Error("boom"), { status: 529 }),
      Object.assign(new Error("boom"), { status: 429 }),
      Object.assign(new Error("boom"), { status: 401 }),
      new Error("Overloaded"),
      new Error("fetch failed"),
      Object.assign(new Error("x"), { cause: Object.assign(new Error("y"), { code: "ECONNREFUSED" }) }),
      Object.assign(new Error("t"), { name: "TimeoutError" }),
    ]) expect(classifyError(e)).toBe("infra");
  });

  it("treats item problems and unknown errors as item", () => {
    for (const e of [
      new Error("model returned junk"),
      new Error("Failed to extract valid output after 3 attempts. Last error: title: Required"),
      new Error("unrouted contribution"),
      "weird",
    ]) expect(classifyError(e)).toBe("item");
  });

  it("backs off 1m, 2m, 4m, 8m, then caps at 15m", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });
});

describe("sweep resilience", () => {
  let base: string;
  let roots: KbRoots;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const drop = (name: string, body: string, submitted = "2026-10-10T01:00:00Z") =>
    writeFileSync(
      join(inbox(), `${name}.md`),
      `---\nfrom: w1\nden_topic_id: ${name}\nchange: create\ncontent_hash: h-${name}\nprev_hash: null\ndomain_hint: wp\nsubmitted: ${submitted}\n---\n\n# ${name}\n\n${body}\n`
    );
  const queued = () => readdirSync(inbox()).filter((f) => f.endsWith(".md"));

  let mode: "ok" | "down" | "junk" | "hang";
  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { signal?: AbortSignal }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      if (mode === "down") throw Object.assign(new Error("Overloaded"), { status: 529 });
      if (mode === "junk") throw new Error("model returned junk");
      if (mode === "hang") {
        return new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal!.reason), { once: true }));
      }
      return schema.parse(opinion("First"));
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  const alerts: string[] = [];
  const run = (over: Partial<Parameters<typeof sweep>[0]> = {}) =>
    sweep({ engine, roots, loadEntryVectors: async () => [], notify: () => {}, alert: (m) => void alerts.push(m), budgetMs: 200, ...over });
  const expire = () => vi.setSystemTime(Date.now() + 16 * 60_000);

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-resil-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(join(roots.kbBase, "domains", "wp", "entries"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
    mode = "ok";
    alerts.length = 0;
    inject.renderIndex = false;
    inject.markProcessed = false;
    vi.mocked(engine.call).mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  it("an infra error doesn't count an attempt, sets backoff, and skips ticks until it expires", async () => {
    drop("a", "body");
    mode = "down";
    const r = await run();
    expect(r.paused).toMatch(/Overloaded/);
    expect(r.parked).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(queued()).toEqual(["a.md"]);
    expect(existsSync(join(roots.denLocal, "sweep-attempts.json"))).toBe(false);
    expect(readBackoff(roots)).toMatchObject({ consecutive: 1 });
    expect(backoffRemainingMs(roots)).toBeGreaterThan(0);

    // Inside the window the tick is skipped without touching the engine.
    const calls = vi.mocked(engine.call).mock.calls.length;
    mode = "ok";
    const skipped = await run();
    expect(skipped.paused).toMatch(/backing off/);
    expect(skipped.created).toBe(0);
    expect(vi.mocked(engine.call).mock.calls.length).toBe(calls);
    expect(queued()).toEqual(["a.md"]);

    expire();
    const ok = await run();
    expect(ok.created).toBe(1);
    expect(readBackoff(roots)).toBeNull();
  });

  it("sends one down alert and one recovery alert across many failing ticks", async () => {
    drop("a", "body");
    mode = "down";
    for (let i = 0; i < 6; i++) {
      await run();
      expire();
    }
    expect(alerts).toEqual(["sweep paused: Overloaded, retrying with backoff"]);
    expect(readBackoff(roots)?.consecutive).toBe(6);

    mode = "ok";
    await run();
    expect(alerts).toEqual([
      "sweep paused: Overloaded, retrying with backoff",
      "sweep recovered: resuming normal operation",
    ]);
  });

  it("an item error counts attempts and parks after maxAttempts, alerting once", async () => {
    drop("bad", "body");
    mode = "junk";
    for (let i = 1; i < SWEEP.maxAttempts; i++) {
      const r = await run();
      expect(r.failures).toHaveLength(1);
      expect(queued()).toEqual(["bad.md"]);
    }
    const last = await run();
    expect(last.parked[0].reason).toBe(`failed ${SWEEP.maxAttempts} times: model returned junk`);
    expect(queued()).toEqual([]);
    expect(readBackoff(roots)).toBeNull();
    expect(alerts).toEqual([`sweep: parked w1/bad — failed ${SWEEP.maxAttempts} times: model returned junk`]);
  });

  it("retries a budget overrun once, then parks it", async () => {
    drop("slow", "body");
    mode = "hang";
    const first = await run();
    expect(first.parked).toEqual([]);
    expect(queued()).toEqual(["slow.md"]);
    expect(alerts).toEqual([]);

    const second = await run();
    expect(second.parked).toHaveLength(1);
    expect(second.parked[0].reason).toMatch(/time budget \(2 times\)/);
    expect(queued()).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/^sweep: parked w1\/slow — /);
  });

  it("an Ollama failure while loading entry vectors backs off instead of throwing", async () => {
    drop("a", "body");
    const r = await run({ loadEntryVectors: async () => { throw new InfraError("Ollama unreachable"); } });
    expect(r.paused).toBe("Ollama unreachable");
    expect(queued()).toEqual(["a.md"]);
    expect(alerts).toEqual(["sweep paused: Ollama unreachable, retrying with backoff"]);
  });

  it("an embed timeout surfaces as infra", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }));
    const err = await createEmbedder(roots).embed("x", "hx").catch((e) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(classifyError(err)).toBe("infra");
    expect(err.message).toMatch(/timed out after 30s/);
    const init = (await (async () => { vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1] })))); await createEmbedder(roots).embed("y", "hy"); return vi.mocked(fetch).mock.calls[0][1]; })()) as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // End to end: the sweep pauses, doesn't count an attempt.
    drop("a", "body");
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }));
    const r = await run();
    expect(r.paused).toMatch(/Ollama timed out/);
    expect(existsSync(join(roots.denLocal, "sweep-attempts.json"))).toBe(false);
  });

  it("writes the ledger before markProcessed or index rendering", async () => {
    drop("a", "body");
    inject.renderIndex = true;
    const notes: string[] = [];
    const r = await run({ notify: (m) => notes.push(m) });
    expect(r.created).toBe(1);
    expect(notes.some((n) => n.includes("index/digest rendering failed"))).toBe(true);
    const types = readLedger(roots).map((e) => e.t);
    expect(types).toEqual(expect.arrayContaining(["contribution", "entry_written", "entry_placed", "aliased"]));
    expect(types.filter((t) => t === "entry_written")).toHaveLength(1);

    // And a crash right after the commit still leaves the ledger record.
    inject.renderIndex = false;
    inject.markProcessed = true;
    drop("b", "other body");
    await run();
    expect(readLedger(roots).filter((e) => e.t === "entry_written")).toHaveLength(2);
  });

  it("noteInfraFailure is atomic and keeps the original start time", async () => {
    await noteInfraFailure(roots, new Error("503 Service Unavailable"), undefined, 1_000);
    const second = await noteInfraFailure(roots, new Error("503 Service Unavailable"), undefined, 2_000);
    expect(second.consecutive).toBe(2);
    expect(second.nextAttemptAt).toBe(2_000 + 120_000);
    expect(readdirSync(roots.opsRoot).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
