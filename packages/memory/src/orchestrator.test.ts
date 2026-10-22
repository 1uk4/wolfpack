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

describe("orchestrator work tagging and Records", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "orch-")); });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  type Item = { title: string; kind: string; stage: string; body: string };
  function engineWithRecord(
    observeQueue: RawObs[][],
    opts: { recordFails?: boolean } = {}
  ) {
    const prompts: { consolidate: string[]; record: string[] } = { consolidate: [], record: [] };
    const engine = {
      call: async (step: string, schema: { parse: (v: unknown) => unknown }, o: { prompt: string }) => {
        if (step === "classify") return schema.parse({ observations: observeQueue.shift() ?? [] });
        if (step === "consolidate") {
          prompts.consolidate.push(o.prompt);
          return schema.parse({ actions: [topicAction("den-topic")] });
        }
        if (step === "workRecord") {
          prompts.record.push(o.prompt);
          if (opts.recordFails) throw new Error("model unavailable");
          return schema.parse({ decisions: [{ decision: "Use TTL cache", why: "simple" }], changes: [], findings: [], problems: [] });
        }
        throw new Error(`unexpected step ${step}`);
      },
    } as unknown as Engine;
    return { engine, prompts };
  }

  function store(items: Record<string, Item>, failSet = false) {
    const writes: Array<{ id: string; body: string }> = [];
    return {
      writes,
      store: {
        get: async (id: string) => (items[id] ? { id, successCriteria: undefined, ...items[id] } : null),
        setBody: async (id: string, body: string) => {
          if (failSet) throw new Error("HTTP 503");
          writes.push({ id, body });
        },
      },
    };
  }

  const OBS: RawObs[] = [
    { timestamp: "2026-10-19 10:00", content: "chose a TTL cache because invalidation is hard" },
    { timestamp: "2026-10-19 10:01", content: "unrelated chatter" },
  ];

  it("stamps observations with the bound task and feature; unbound ones carry no tag", async () => {
    let bound: { taskId: string; featureId?: string } | null = { taskId: "work-t1", featureId: "work-f1" };
    const { engine } = engineWithRecord([[OBS[0]], [OBS[1]]]);
    const orch = createOrchestrator(engine, makeRuntime(cwd), { consolidateAtPoolTokens: 1e9, getBoundWork: () => bound });
    await orch.processChunks([chunk("c1")]);
    bound = null;
    await orch.processChunks([chunk("c2")]);

    const [a, b] = orch.getActiveObservations();
    expect(a).toMatchObject({ work: "work-t1", feature: "work-f1" });
    expect(b.work).toBeUndefined();
    expect(b.feature).toBeUndefined();
  });

  it("den consolidation skips tagged observations; the Record gets them", async () => {
    const { engine, prompts } = engineWithRecord([[OBS[0]], [OBS[1]]]);
    const s = store({ "work-t1": { title: "Fix cache", kind: "task", stage: "in_build", body: "## Plan\n\nplan text" } });
    let bound: { taskId: string } | null = { taskId: "work-t1" };
    const orch = createOrchestrator(engine, makeRuntime(cwd), { consolidateAtPoolTokens: 1e9, getBoundWork: () => bound, workRecordStore: s.store });
    await orch.processChunks([chunk("c1")]);
    bound = null;
    await orch.processChunks([chunk("c2")]);
    await orch.consolidateNow();

    // the den pass saw only the untagged observation
    expect(prompts.consolidate).toHaveLength(1);
    expect(prompts.consolidate[0]).toContain("unrelated chatter");
    expect(prompts.consolidate[0]).not.toContain("TTL cache");
    // the Record pass saw the tagged one, and the plan
    expect(prompts.record[0]).toContain("TTL cache");
    expect(prompts.record[0]).toContain("plan text");
    expect(prompts.record[0]).not.toContain("unrelated chatter");
    expect(s.writes).toHaveLength(1);
    expect(s.writes[0].body).toBe("## Plan\n\nplan text\n\n## Record\n\n### Decisions\n\n- Use TTL cache — why: simple\n");
    // both consumed
    expect(orch.getActiveObservations()).toEqual([]);
  });

  it("an infra failure keeps the tagged observations pending for the next run", async () => {
    const { engine, prompts } = engineWithRecord([[OBS[0]]]);
    const s = store({ "work-t1": { title: "T", kind: "task", stage: "in_build", body: "" } }, true);
    const orch = createOrchestrator(engine, makeRuntime(cwd), { consolidateAtPoolTokens: 1e9, getBoundWork: () => ({ taskId: "work-t1" }), workRecordStore: s.store });
    await orch.processChunks([chunk("c1")]);
    await orch.consolidateNow();

    expect(orch.getActiveObservations().map((o) => o.content)).toEqual([OBS[0].content]);
    expect(prompts.consolidate).toEqual([]); // nothing leaked to the den
    // next run, the Work API is back
    s.store.setBody = async (id: string, body: string) => { s.writes.push({ id, body }); };
    await orch.consolidateNow();
    expect(orch.getActiveObservations()).toEqual([]);
    expect(s.writes).toHaveLength(1);
  });

  it("a model failure keeps them pending too", async () => {
    const { engine } = engineWithRecord([[OBS[0]]], { recordFails: true });
    const s = store({ "work-t1": { title: "T", kind: "task", stage: "in_build", body: "" } });
    const orch = createOrchestrator(engine, makeRuntime(cwd), { consolidateAtPoolTokens: 1e9, getBoundWork: () => ({ taskId: "work-t1" }), workRecordStore: s.store });
    await orch.processChunks([chunk("c1")]);
    await orch.consolidateNow();
    expect(orch.getActiveObservations()).toHaveLength(1);
    expect(s.writes).toEqual([]);
  });

  it("observations of an archived or deleted item fall back to den consolidation", async () => {
    const { engine, prompts } = engineWithRecord([[OBS[0], OBS[1]]]);
    const s = store({ "work-t1": { title: "T", kind: "task", stage: "archived", body: "" } });
    const orch = createOrchestrator(engine, makeRuntime(cwd), { consolidateAtPoolTokens: 1e9, getBoundWork: () => ({ taskId: "work-t1" }), workRecordStore: s.store });
    await orch.processChunks([chunk("c1")]);
    await orch.consolidateNow();

    expect(prompts.record).toEqual([]);
    expect(prompts.consolidate[0]).toContain("TTL cache");
    expect(orch.getActiveObservations()).toEqual([]);
  });

  it("observations of two tasks of one feature fold into one Record on the feature; an Inbox task keeps its own", async () => {
    const { engine, prompts } = engineWithRecord([[OBS[0]], [OBS[1]], [{ timestamp: "2026-10-19 10:02", content: "inbox chore done" }]]);
    const s = store({
      "work-f1": { title: "The feature", kind: "feature", stage: "in_build", body: "## Plan\n\nfeature plan" },
      "work-inbox": { title: "Inbox", kind: "feature", stage: "plan", body: "", container: true } as Item,
      "work-t1": { title: "T1", kind: "task", stage: "in_build", body: "" },
      "work-t2": { title: "T2", kind: "task", stage: "in_build", body: "" },
      "work-t3": { title: "T3", kind: "task", stage: "in_build", body: "" },
    });
    let bound: { taskId: string; featureId?: string } = { taskId: "work-t1", featureId: "work-f1" };
    const orch = createOrchestrator(engine, makeRuntime(cwd), { consolidateAtPoolTokens: 1e9, getBoundWork: () => bound, workRecordStore: s.store });
    await orch.processChunks([chunk("c1")]);
    bound = { taskId: "work-t2", featureId: "work-f1" };
    await orch.processChunks([chunk("c2")]);
    bound = { taskId: "work-t3", featureId: "work-inbox" }; // pending line from before: feature is the container
    await orch.processChunks([chunk("c3")]);
    await orch.consolidateNow();

    expect(s.writes.map((w) => w.id).sort()).toEqual(["work-f1", "work-t3"]);
    expect(prompts.record.find((p) => p.includes("The feature"))).toContain("unrelated chatter");
    expect(prompts.record.find((p) => p.includes("The feature"))).toContain("TTL cache");
    expect(prompts.consolidate).toEqual([]);
    expect(orch.getActiveObservations()).toEqual([]);
  });
});
