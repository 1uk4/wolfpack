/**
 * Session-topic layer on a durable wolf: consolidate (pool -> session topics), promote (session topics -> den ->
 * inbox contributions) behind the single-promote guard, and reconcileDen at start. Driven through a sandboxed
 * startTestWolf and through the createWolfHarness-style Harness.open path (production), with the stubbed `engine.call`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, Harness } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/index.js";
import { NodeExecutionEnv } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/env/node.js";
import { openNodeSqliteStorage } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { contentHash } from "@wolfpack/kb/shared";
import { writeDenTopic } from "@wolfpack/memory";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { attachConversationReader } from "../../packages/harness/src/engine/conversation-reader.js";
import { ENGINE_CONTEXT as ctx } from "../../packages/harness/src/engine/index.js";
import { createScriptedModel, fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import { memoryActionsFor } from "./memory-actions.js";
import createMemoryExtension from "./unified.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `st-${p}-`));
  dirs.push(d);
  return d;
};
let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stubEngine() {
  const steps: string[] = [];
  let release: (() => void) | undefined;
  const gate = { hold: false };
  const engine = {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, args: { prompt: string }) => {
      steps.push(step);
      if (step === "classify") return schema.parse({ observations: [{ timestamp: "2026-10-25 10:01", content: "We cache session lookups for five minutes" }] });
      if (step === "consolidate") {
        if (gate.hold) await new Promise<void>((r) => (release = r));
        return schema.parse({
          actions: [{ sessionTopicId: "x", action: "create", reasoning: "new", result: { id: "caching", title: "Caching", summary: "Session lookups are cached", body: "Cache session lookups for five minutes because the profile endpoint is the hot path." } }],
        });
      }
      if (step === "distill") {
        return schema.parse({ contributions: [{ slug: "main", title: /^TOPIC TITLE: (.*)$/m.exec(args.prompt)?.[1] ?? "Caching", summary: "Session lookups are cached", body: "## Details\nCache session lookups for five minutes." }] });
      }
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
  return { engine, steps, gate, release: () => release?.() };
}

function seedPool(den: string, n = 3): void {
  const dir = join(den, ".memory", "pool");
  mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: n }, (_, i) => ({
    timestamp: `2026-10-25T10:0${i}:00`,
    content: `Observation ${i}: we cache session lookups for five minutes`,
    recordedAt: "2026-10-25T10:00:00Z",
    domain: "wolfpack",
  }));
  writeFileSync(join(dir, "observations.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const poolEmpty = (den: string) => {
  const f = join(den, ".memory/pool/observations.jsonl");
  return !existsSync(f) || readFileSync(f, "utf8").trim() === "";
};

async function liveRoot() {
  const live = tmp("live");
  const work = join(live, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "live-fixture" });
  await srv.close();
  mkdirSync(join(live, "ops"), { recursive: true });
  mkdirSync(join(live, "den"), { recursive: true });
  return { live, work };
}
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out[p + "/"] = "dir"; walk(p); }
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex") + ":" + statSync(p).size;
    }
  };
  walk(dir);
  return out;
}

async function startWolf(engine: Engine, prepare?: (dev: string) => void) {
  const { live, work } = await liveRoot();
  // The sandbox leaves KB_BASE ambient (read-only); an empty KB is enough for the inbox/receipt lanes.
  const kbBase = tmp("kb");
  const before = hashTree(live);
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(live, "ops"), denDir: join(live, "den") }, devRoot: dev });
  prepare?.(dev);
  tw = await startTestWolf({
    script: [fauxAssistantMessage("ok")],
    yaml: `sandbox:\n  root: ${dev}\n`,
    hooks: {
      extensions: ({ config, den, env }) => [
        adaptToDurable(
          createMemoryExtension({ engine }, { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env: { ...env, KB_BASE: kbBase } }),
          { wolfDen: den, wolfName: "testwolf" },
        ),
      ],
    },
  });
  return { dev, den: join(dev, "den"), live, before };
}

describe("session-topic layer (sandboxed durable wolf)", () => {
  it("consolidate folds the pool into session topics, not den topics", async () => {
    const stub = stubEngine();
    const { den } = await startWolf(stub.engine);
    seedPool(den);
    const res = await memoryActionsFor(den)!.consolidate();
    expect(res.observationsProcessed).toBe(3);
    const sessionDir = join(den, ".memory/sessions/durable");
    expect(readFileSync(join(sessionDir, "caching.md"), "utf8")).toContain("Cache session lookups");
    expect(existsSync(join(sessionDir, "INDEX.md"))).toBe(true);
    expect(existsSync(join(den, "memory/topics"))).toBe(false);
    expect(poolEmpty(den)).toBe(true);
  });

  it("promote moves session topics to den topics and inbox contributions for the wolf; live roots untouched", async () => {
    const stub = stubEngine();
    const { dev, den, live, before } = await startWolf(stub.engine);
    seedPool(den);
    const start = memoryActionsFor(den)!.promote();
    expect(start.status).toBe("started");
    if (start.status !== "started") return;
    const out = await start.done;
    expect(out.consolidated).toBe(3);
    expect(out.promoted.topicsCreated).toBe(1);
    expect(readFileSync(join(den, "memory/topics/caching.md"), "utf8")).toContain("Cache session lookups");
    const inbox = join(dev, "ops/inbox/testwolf");
    const files = readdirSync(inbox);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.startsWith("caching"))).toBe(true);
    expect(stub.steps).toEqual(expect.arrayContaining(["consolidate", "distill"]));
    expect(hashTree(live)).toEqual(before);
  });

  it("a second concurrent promote is refused by the single-promote guard; a later one runs", async () => {
    const stub = stubEngine();
    stub.gate.hold = true;
    const { den } = await startWolf(stub.engine);
    seedPool(den);
    const actions = memoryActionsFor(den)!;
    const first = actions.promote();
    const second = actions.promote();
    expect(first.status).toBe("started");
    expect(second).toMatchObject({ status: "already_running", jobId: (first as { jobId: string }).jobId });
    const deadline = Date.now() + 4000;
    while (!stub.steps.includes("consolidate") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    stub.gate.hold = false;
    stub.release();
    await (first as Extract<typeof first, { status: "started" }>).done;
    expect(stub.steps.filter((s) => s === "consolidate")).toHaveLength(1);
    expect(actions.promote().status).toBe("started");
  });

  it("reconcileDen at wolf start archives a topic the KB absorbed (receipt fixture)", async () => {
    const stub = stubEngine();
    const body = "Absorbed topic body";
    const { den } = await startWolf(stub.engine, (dev) => {
      writeDenTopic(join(dev, "den"), { id: "absorbed", title: "Absorbed", summary: "s", updated: "2026-10-20 10:00", body });
      writeDenTopic(join(dev, "den"), { id: "fresh", title: "Fresh", summary: "s", updated: "2026-10-20 10:00", body: "Fresh body" });
      const dir = join(dev, "ops/receipts/testwolf");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `absorbed-${contentHash(body).slice(7, 17)}.md`), `---\nfrom: testwolf\nden_topic_id: absorbed\noutcome: merge\nprocessed: 2026-10-19 20:20\n---\n\nkb-wolfpack-AAAAAAA\n`);
    });
    expect(existsSync(join(den, "memory/topics/absorbed.md"))).toBe(false);
    expect(existsSync(join(den, "memory/archive/absorbed.md"))).toBe(true);
    expect(existsSync(join(den, "memory/topics/fresh.md"))).toBe(true);
  });
});

describe("session-topic layer (createWolfHarness-style Harness.open)", () => {
  it("consolidate writes session topics; promote writes den topics and inbox contributions", async () => {
    const dir = tmp("host");
    const ops = tmp("ops");
    const stub = stubEngine();
    const sm = createScriptedModel([fauxAssistantMessage("HOSTREPLY we decided to cache the session lookups for five minutes because of the hot path.")]);
    const registry = createRegistry();
    registry.install(adaptToDurable(createMemoryExtension({ live: true, engine: stub.engine }, { wolfDen: dir, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: { KB_BASE: join(ops, "kb"), KB_OPS: ops } }), { wolfDen: dir, wolfName: "w" }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "session.sqlite")), { models: sm.models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? dir }) }, ctx);
    const detach = attachConversationReader(harness, dir, { hostConsolidationTimer: true });
    const root = await harness.root(ctx, { agent: { model: { provider: sm.provider, modelId: sm.modelId } } });
    harness.resume();
    await root.submit({ type: "input", content: "HOSTUSER please remember the caching decision we made today.", whenBusy: "reject" }, ctx);
    await root.waitForIdle(ctx);
    for (let i = 0; i < 100 && !existsSync(join(dir, ".memory/pool/observations.jsonl")); i++) await new Promise((r) => setTimeout(r, 30));

    const actions = memoryActionsFor(dir)!;
    expect(actions).toBeDefined();
    await actions.consolidate();
    expect(existsSync(join(dir, ".memory/sessions/durable/caching.md"))).toBe(true);
    expect(existsSync(join(dir, "memory/topics"))).toBe(false);

    const start = actions.promote();
    if (start.status !== "started") throw new Error("promote not started");
    await start.done;
    expect(existsSync(join(dir, "memory/topics/caching.md"))).toBe(true);
    expect(readdirSync(join(ops, "inbox/w")).length).toBeGreaterThan(0);
    detach();
    await harness.close(ctx);
  });
});

describe("host interval timer (createWolfHarness path)", () => {
  it("a tick consolidates + promotes (den topics + inbox files); threshold consolidation yields session topics only; one timer", async () => {
    const dir = tmp("host-timer");
    const ops = tmp("ops-timer");
    const stub = stubEngine();
    const sm = createScriptedModel([fauxAssistantMessage("HOSTREPLY we decided to cache the session lookups for five minutes because of the hot path.")]);
    const registry = createRegistry();
    // threshold 1: the first observation triggers threshold consolidation (session topics only)
    registry.install(adaptToDurable(createMemoryExtension({ live: true, engine: stub.engine, consolidation: { trigger: "hybrid", threshold: 1, poolTarget: 0 }, intervalMs: 50 }, { wolfDen: dir, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: { KB_BASE: join(ops, "kb"), KB_OPS: ops } }), { wolfDen: dir, wolfName: "w" }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "session.sqlite")), { models: sm.models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? dir }) }, ctx);
    const detach = attachConversationReader(harness, dir, { hostConsolidationTimer: true });
    const root = await harness.root(ctx, { agent: { model: { provider: sm.provider, modelId: sm.modelId } } });
    harness.resume();
    await root.submit({ type: "input", content: "HOSTUSER please remember the caching decision we made today.", whenBusy: "reject" }, ctx);
    await root.waitForIdle(ctx);
    const session = join(dir, ".memory/sessions/durable/caching.md");
    for (let i = 0; i < 100 && !existsSync(session); i++) await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(session)).toBe(true);
    // threshold path: session topics only, no den, no inbox; the extension started no timer of its own
    expect(existsSync(join(dir, "memory/topics"))).toBe(false);
    expect(existsSync(join(ops, "inbox"))).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(dir, "memory/topics"))).toBe(false);

    // The host's tick (createWolfHarness): promote through the registered actions
    const job = memoryActionsFor(dir)!.promote();
    if (job.status !== "started") throw new Error("not started");
    await job.done;
    expect(existsSync(join(dir, "memory/topics/caching.md"))).toBe(true);
    expect(readdirSync(join(ops, "inbox/w")).length).toBeGreaterThan(0);
    detach();
    await harness.close(ctx);
    // closed: the actions no longer leak
    expect(memoryActionsFor(dir)).toBeUndefined();
  });

  it("promote without KB roots rejects with a clear message and changes nothing", async () => {
    const stub = stubEngine();
    const { den } = await startWolf(stub.engine);
    seedPool(den);
    // a wolf with no KB_BASE/KB_OPS: build the extension directly
    const d2 = tmp("nokb");
    seedPool(d2);
    const ext = createMemoryExtension({ live: true, engine: stub.engine }, { wolfDen: d2, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {} });
    expect(ext).toBeDefined();
    const job = memoryActionsFor(d2)!.promote();
    if (job.status !== "started") throw new Error("not started");
    await expect(job.done).rejects.toThrow(/KB roots/);
    expect(memoryActionsFor(d2)!.promoteEnabled).toBe(false);
    expect(existsSync(join(d2, ".memory/sessions"))).toBe(false);
    expect(poolEmpty(d2)).toBe(false);
    memoryActionsFor(d2); // (registry entry is released by lifecycle stop)
  });

  it("without KB roots the interval tick only consolidates into session topics, quietly", async () => {
    const stub = stubEngine();
    const d = tmp("nokb-tick");
    seedPool(d);
    const sm = createScriptedModel([fauxAssistantMessage("HOSTREPLY we decided to cache the session lookups for five minutes because of the hot path.")]);
    const registry = createRegistry();
    registry.install(adaptToDurable(createMemoryExtension({ live: true, engine: stub.engine, intervalMs: 50 }, { wolfDen: d, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {} }), { wolfDen: d, wolfName: "w" }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(d, "session.sqlite")), { models: sm.models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? d }) }, ctx);
    const detach = attachConversationReader(harness, d);
    const root = await harness.root(ctx, { agent: { model: { provider: sm.provider, modelId: sm.modelId } } });
    harness.resume();
    await root.submit({ type: "input", content: "HOSTUSER please remember the caching decision we made today.", whenBusy: "reject" }, ctx);
    await root.waitForIdle(ctx);
    const session = join(d, ".memory/sessions/durable/caching.md");
    for (let i = 0; i < 100 && !existsSync(session); i++) await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(session)).toBe(true);
    expect(existsSync(join(d, "memory/topics"))).toBe(false);
    expect(stub.steps).not.toContain("distill");
    detach();
    await harness.close(ctx);
  });
});
