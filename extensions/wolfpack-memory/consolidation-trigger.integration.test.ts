/**
 * memory.consolidation.trigger under the durable (wolfd-style) path: manual | threshold | timer | hybrid.
 * Drives createMemoryExtension through Harness.open with a stubbed engine. The tick period is a short real interval
 * (the extension's `intervalMs` seam); the logs "Threshold reached" / "Timer-triggered" tell the two paths apart.
 * work-wolfpack-2oIgO5b
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, Harness } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/index.js";
import { NodeExecutionEnv } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/env/node.js";
import { openNodeSqliteStorage } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { attachConversationReader } from "../../packages/harness/src/engine/conversation-reader.js";
import { ENGINE_CONTEXT as ctx } from "../../packages/harness/src/engine/index.js";
import { createScriptedModel, fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { effectiveConsolidationInterval, parseConsolidationInterval } from "@wolfpack/engine";
import createMemoryExtension from "./unified.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stubEngine(): Engine {
  return {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classify") return schema.parse({ observations: [{ timestamp: "2026-10-25 10:01", content: "We cache session lookups for five minutes" }] });
      if (step === "consolidate") {
        return schema.parse({
          actions: [{ sessionTopicId: "x", action: "create", reasoning: "new", result: { id: "caching", title: "Caching", summary: "Session lookups are cached", body: "Cache session lookups for five minutes because the profile endpoint is the hot path." } }],
        });
      }
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
}

function seedPool(den: string): void {
  const dir = join(den, ".memory", "pool");
  mkdirSync(dir, { recursive: true });
  const row = { timestamp: "2026-10-25T10:00:00", content: "Observation: we cache session lookups for five minutes", recordedAt: "2026-10-25T10:00:00Z", domain: "wolfpack" };
  writeFileSync(join(dir, "observations.jsonl"), JSON.stringify(row) + "\n");
}

/** Boot a wolf with one observation recorded; `during` runs while it is up. Returns the logs seen, split at close. */
async function withWolf(consolidation: Record<string, unknown>, during: (w: { den: string; logs: () => string[]; session: string }) => Promise<void>, afterClose?: (w: { den: string; logs: () => string[] }) => Promise<void>) {
  const den = mkdtempSync(join(tmpdir(), "trig-"));
  dirs.push(den);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const sm = createScriptedModel([fauxAssistantMessage("REPLY we decided to cache the session lookups for five minutes because of the hot path.")]);
  const registry = createRegistry();
  registry.install(adaptToDurable(createMemoryExtension({ live: true, engine: stubEngine(), consolidation, intervalMs: 50 } as never, { wolfDen: den, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {} }), { wolfDen: den, wolfName: "w" }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(den, "session.sqlite")), { models: sm.models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? den }) }, ctx);
  const detach = attachConversationReader(harness, den); // no host timer: the extension owns it
  const root = await harness.root(ctx, { agent: { model: { provider: sm.provider, modelId: sm.modelId } } });
  harness.resume();
  await root.submit({ type: "input", content: "USER please remember the caching decision we made today.", whenBusy: "reject" }, ctx);
  await root.waitForIdle(ctx);
  await sleep(400);
  try {
    await during({ den, logs: () => lines, session: join(den, ".memory/sessions/durable/caching.md") });
  } finally {
    detach();
    await harness.close(ctx);
  }
  if (afterClose) await afterClose({ den, logs: () => lines });
}

const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;
const THRESHOLD = /Threshold reached/;
const TIMER = /Timer-triggered/;

describe("memory.consolidation.trigger", () => {
  it("manual: neither the threshold nor the timer consolidates", async () => {
    await withWolf({ trigger: "manual", threshold: 1, poolTarget: 0, interval: "4h" }, async ({ den, logs, session }) => {
      // the observer ran (it pooled the exchange), so the zero counts below are not vacuous
      const pool = join(den, ".memory", "pool", "observations.jsonl");
      expect(existsSync(pool) && readFileSync(pool, "utf8").trim().length > 0).toBe(true);
      seedPool(den);
      await sleep(300);
      expect(count(logs(), THRESHOLD)).toBe(0);
      expect(count(logs(), TIMER)).toBe(0);
      expect(existsSync(session)).toBe(false);
    });
  });

  it("threshold: consolidates at the threshold, starts no timer", async () => {
    await withWolf({ trigger: "threshold", threshold: 1, poolTarget: 0 }, async ({ den, logs, session }) => {
      expect(count(logs(), THRESHOLD)).toBeGreaterThan(0);
      expect(existsSync(session)).toBe(true);
      const before = count(logs(), TIMER);
      seedPool(den);
      await sleep(300);
      expect(count(logs(), TIMER)).toBe(before);
      expect(before).toBe(0);
    });
  });

  it("timer: ticks on the interval, never consolidates on the threshold", async () => {
    await withWolf({ trigger: "timer", threshold: 1, poolTarget: 0 }, async ({ logs, session }) => {
      expect(count(logs(), TIMER)).toBeGreaterThan(0);
      expect(count(logs(), THRESHOLD)).toBe(0);
      expect(existsSync(session)).toBe(true);
    });
  });

  it("hybrid (the default): both the threshold and the timer", async () => {
    await withWolf({ threshold: 1, poolTarget: 0 }, async ({ den, logs }) => {
      expect(count(logs(), THRESHOLD)).toBeGreaterThan(0);
      const before = count(logs(), TIMER);
      seedPool(den);
      await sleep(300);
      expect(count(logs(), TIMER)).toBeGreaterThan(before);
    });
  });

  it("the timer is cleared when the wolf closes", async () => {
    let seen = 0;
    await withWolf(
      { trigger: "timer", poolTarget: 0 },
      async ({ logs }) => {
        expect(count(logs(), TIMER)).toBeGreaterThan(0);
      },
      async ({ den, logs }) => {
        await sleep(150); // let a tick already in flight at close finish logging
        seen = count(logs(), TIMER);
        seedPool(den);
        await sleep(300);
        expect(count(logs(), TIMER)).toBe(seen);
      },
    );
  });

  it("a bad interval warns and falls back instead of crashing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const den = mkdtempSync(join(tmpdir(), "trig-bad-"));
    dirs.push(den);
    expect(() => createMemoryExtension({ live: true, engine: stubEngine(), consolidation: { trigger: "timer", interval: "soon" } } as never, { wolfDen: den, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {} })).not.toThrow();
    expect(warn.mock.calls.some((c) => /invalid memory.consolidation.interval "soon": using 4h/.test(String(c[0])))).toBe(true);
  });
});

describe("consolidation interval normaliser", () => {
  it("accepts valid durations", () => {
    expect(parseConsolidationInterval("30s")).toBe(30_000);
    expect(parseConsolidationInterval("15m")).toBe(900_000);
    expect(parseConsolidationInterval("4h")).toBe(14_400_000);
    expect(parseConsolidationInterval("1d")).toBe(86_400_000);
    expect(effectiveConsolidationInterval("2h")).toBe("2h");
  });
  it.each(["0s", "0h", "30d", "soon", ""])("rejects %j and falls back to 4h", (v) => {
    expect(parseConsolidationInterval(v)).toBeUndefined();
    expect(effectiveConsolidationInterval(v)).toBe("4h");
  });
  it("undefined is 4h", () => expect(effectiveConsolidationInterval(undefined)).toBe("4h"));
});

/** Boot only (no message). `seed` runs before boot. Counts engine consolidate calls and 50ms timers (the intervalMs seam). */
async function bootOnly(consolidation: Record<string, unknown>, seed: ((den: string) => void) | undefined, during: (w: { den: string; consolidateCalls: () => number; timers: () => number; harnessRoot: () => Promise<void> }) => Promise<void>) {
  const den = mkdtempSync(join(tmpdir(), "boot-"));
  dirs.push(den);
  if (seed) seed(den);
  vi.spyOn(console, "log").mockImplementation(() => {});
  let consolidates = 0;
  const base = stubEngine();
  const engine = { call: (step: string, schema: never, ...rest: never[]) => { if (step === "consolidate") consolidates++; return (base.call as (...a: unknown[]) => unknown)(step, schema, ...rest); } } as unknown as Engine;
  const realSetInterval = globalThis.setInterval;
  let timers = 0;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: never, ms?: number, ...a: never[]) => {
    if (ms === 50) timers++;
    return (realSetInterval as (...x: unknown[]) => unknown)(fn, ms, ...a);
  }) as never);
  const sm = createScriptedModel([fauxAssistantMessage("REPLY we decided to cache the session lookups for five minutes because of the hot path.")]);
  const registry = createRegistry();
  registry.install(adaptToDurable(createMemoryExtension({ live: true, engine, consolidation, intervalMs: 50 } as never, { wolfDen: den, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {} }), { wolfDen: den, wolfName: "w" }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(den, "session.sqlite")), { models: sm.models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? den }) }, ctx);
  const detach = attachConversationReader(harness, den);
  try {
    const harnessRoot = async () => {
      const root = await harness.root(ctx, { agent: { model: { provider: sm.provider, modelId: sm.modelId } } });
      harness.resume();
      await root.submit({ type: "input", content: "USER please remember the caching decision we made today.", whenBusy: "reject" }, ctx);
      await root.waitForIdle(ctx);
      await sleep(300);
    };
    await during({ den, consolidateCalls: () => consolidates, timers: () => timers, harnessRoot });
  } finally {
    detach();
    await harness.close(ctx);
  }
}

describe("boot-time consolidation timer", () => {
  it("non-empty pool, no messages: the timer fires and consolidates", async () => {
    await bootOnly({ trigger: "timer", poolTarget: 0 }, seedPool, async ({ den, consolidateCalls, timers }) => {
      await sleep(400);
      expect(timers()).toBe(1);
      expect(consolidateCalls()).toBeGreaterThan(0);
      expect(existsSync(join(den, ".memory/sessions/durable/caching.md"))).toBe(true);
    });
  });

  it("nothing new since the last save: later ticks do not consolidate again", async () => {
    await bootOnly({ trigger: "timer", poolTarget: 0 }, seedPool, async ({ consolidateCalls }) => {
      await sleep(400);
      const n = consolidateCalls();
      expect(n).toBeGreaterThan(0);
      await sleep(300);
      expect(consolidateCalls()).toBe(n);
    });
  });

  it("empty pool: it ticks without consolidating, then consolidates once something arrives", async () => {
    await bootOnly({ trigger: "hybrid", threshold: 1_000_000, poolTarget: 0 }, undefined, async ({ den, consolidateCalls, timers }) => {
      await sleep(300);
      expect(timers()).toBe(1);
      expect(consolidateCalls()).toBe(0);
      seedPool(den); // proves the timer is alive
      await sleep(300);
      expect(consolidateCalls()).toBeGreaterThan(0);
    });
  });

  it("exactly one timer after the first observation", async () => {
    await bootOnly({ trigger: "hybrid", threshold: 1_000_000, poolTarget: 0 }, undefined, async ({ timers, harnessRoot }) => {
      expect(timers()).toBe(1);
      await harnessRoot();
      expect(timers()).toBe(1);
    });
  });

  it.each(["manual", "threshold"])("%s: no timer at boot or after an observation", async (trigger) => {
    await bootOnly({ trigger, threshold: 1_000_000, poolTarget: 0 }, seedPool, async ({ timers, consolidateCalls, harnessRoot }) => {
      await sleep(200);
      expect(timers()).toBe(0);
      await harnessRoot();
      expect(timers()).toBe(0);
      expect(consolidateCalls()).toBe(0);
    });
  });
});
