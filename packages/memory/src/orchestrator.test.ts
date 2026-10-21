import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { createOrchestrator } from "./orchestrator.js";
import type { AgentRuntime, ConversationChunk, LedgerEntry } from "./runtime.js";
import { readTopics } from "./session/memory.js";

type RawObs = { timestamp: string; content: string; domain?: string };

function makeEngine(
  observeQueue: RawObs[][],
  consolidateActions: (prompt: string) => unknown[]
): Engine {
  return {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
      if (step === "classify") return schema.parse({ observations: observeQueue.shift() ?? [] });
      if (step === "consolidate") return schema.parse({ actions: consolidateActions(opts.prompt) });
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
}

function makeRuntime(cwd: string): AgentRuntime {
  const ledger: LedgerEntry[] = [];
  return {
    name: "test",
    cwd,
    sessionId: "sess-1",
    getNewChunks: () => [],
    appendLedger: (e) => ledger.push(e),
    readLedger: () => ledger,
    on: () => () => {},
  };
}

const chunk = (id: string): ConversationChunk => ({
  id,
  text: `chunk ${id}`,
  tokenCount: 10,
  timestamp: "2026-10-19 10:00",
});

const topicAction = (id: string, domain?: string) => ({
  sessionTopicId: id,
  action: "create",
  result: { id, title: id, summary: id, body: "b", ...(domain ? { domain } : {}) },
  reasoning: "r",
});

describe("orchestrator domain stamping", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "orch-")); });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("stamps untagged observations with the default domain and keeps explicit tags", async () => {
    const engine = makeEngine(
      [[
        { timestamp: "2026-10-19 10:00", content: "untagged" },
        { timestamp: "2026-10-19 10:01", content: "tagged", domain: "personal" },
      ]],
      () => []
    );
    const orch = createOrchestrator(engine, makeRuntime(cwd), {
      defaultDomain: "wolfpack",
      consolidateAtPoolTokens: 1e9,
    });
    await orch.processChunks([chunk("c1")]);

    const byContent = Object.fromEntries(orch.getActiveObservations().map((o) => [o.content, o.domain]));
    expect(byContent).toEqual({ untagged: "wolfpack", tagged: "personal" });
  });

  it("setDefaultDomain only affects observations recorded afterwards", async () => {
    const engine = makeEngine(
      [
        [{ timestamp: "2026-10-19 10:00", content: "before" }],
        [{ timestamp: "2026-10-19 10:05", content: "after" }],
      ],
      () => []
    );
    const orch = createOrchestrator(engine, makeRuntime(cwd), {
      defaultDomain: "wolfpack",
      consolidateAtPoolTokens: 1e9,
    });
    await orch.processChunks([chunk("c1")]);
    orch.setDefaultDomain("personal");
    await orch.processChunks([chunk("c2")]);

    const byContent = Object.fromEntries(orch.getActiveObservations().map((o) => [o.content, o.domain]));
    expect(byContent).toEqual({ before: "wolfpack", after: "personal" });
  });

  it("falls back to the batch's sole domain when the consolidator drops a topic's domain", async () => {
    const engine = makeEngine(
      [[
        { timestamp: "2026-10-19 10:00", content: "a", domain: "personal" },
        { timestamp: "2026-10-19 10:01", content: "b", domain: "personal" },
      ]],
      () => [topicAction("no-domain-topic")]
    );
    const orch = createOrchestrator(engine, makeRuntime(cwd), { defaultDomain: "wolfpack" });
    await orch.processChunks([chunk("c1")]);
    await orch.consolidateNow();

    const topic = readTopics(orch.getMemoryRoot()).find((t) => t.id === "no-domain-topic");
    expect(topic?.domain).toBe("personal");
  });

  it("leaves the domain unset when a mixed batch's topic has no domain", async () => {
    const engine = makeEngine(
      [[
        { timestamp: "2026-10-19 10:00", content: "a", domain: "personal" },
        { timestamp: "2026-10-19 10:01", content: "b", domain: "wolfpack" },
      ]],
      () => [topicAction("mixed-topic"), topicAction("tagged-topic", "wolfpack")]
    );
    const orch = createOrchestrator(engine, makeRuntime(cwd), { defaultDomain: "wolfpack" });
    await orch.processChunks([chunk("c1")]);
    await orch.consolidateNow();

    const topics = Object.fromEntries(readTopics(orch.getMemoryRoot()).map((t) => [t.id, t.domain]));
    expect(topics["mixed-topic"]).toBeUndefined();
    expect(topics["tagged-topic"]).toBe("wolfpack");
  });
});

describe("orchestrator concurrent observation", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "orch-")); });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("observations recorded while consolidation runs survive it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const consolidating = new Promise<void>((r) => (started = r));
    const queue: RawObs[][] = [
      [{ timestamp: "2026-10-19 10:00", content: "early" }],
      [{ timestamp: "2026-10-19 10:05", content: "late" }],
    ];
    const engine = {
      call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
        if (step === "classify") return schema.parse({ observations: queue.shift() ?? [] });
        started();
        await gate;
        return schema.parse({ actions: [] });
      },
    } as unknown as Engine;
    const orch = createOrchestrator(engine, makeRuntime(cwd), { consolidateAtPoolTokens: 1e9 });
    await orch.processChunks([chunk("c1")]);

    const running = orch.consolidateNow();
    await consolidating;
    await orch.processChunks([chunk("c2")]); // observer fires mid-consolidation
    release();
    await running;

    expect(orch.getActiveObservations().map((o) => o.content)).toEqual(["late"]);
  });

  it("serializes consolidation runs so one pool snapshot is never consolidated twice", async () => {
    let consolidateCalls = 0;
    const engine = makeEngine(
      [[{ timestamp: "2026-10-19 10:00", content: "only" }]],
      () => { consolidateCalls++; return []; }
    );
    const orch = createOrchestrator(engine, makeRuntime(cwd), { consolidateAtPoolTokens: 1e9 });
    await orch.processChunks([chunk("c1")]);
    await Promise.all([orch.consolidateNow(), orch.consolidateNow()]);
    expect(consolidateCalls).toBe(1);
    expect(orch.getActiveObservations()).toEqual([]);
  });
});
