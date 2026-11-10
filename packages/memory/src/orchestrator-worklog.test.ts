import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { createOrchestrator } from "./orchestrator.js";
import type { AgentRuntime, ConversationChunk, LedgerEntry } from "./runtime.js";
import { InMemoryWorkRecordStore, type AppendRecordResult, type RecordAppendLine } from "./work-record.js";
import { readArchive } from "./work-pending.js";

type RawObs = { timestamp: string; content: string };

function makeRuntime(cwd: string): AgentRuntime {
  const ledger: LedgerEntry[] = [];
  return { name: "test", cwd, sessionId: "sess-1", getNewChunks: () => [], appendLedger: (e) => ledger.push(e), readLedger: () => ledger, on: () => () => {} };
}
const chunk: ConversationChunk = { id: "c", text: "chunk", tokenCount: 10, timestamp: "2026-10-19 10:00" };

describe("orchestrator workLog append mode", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "orch-log-")); });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const obs = (n: number, from = 0): RawObs[] =>
    Array.from({ length: n }, (_, i) => ({ timestamp: `2026-10-19 10:${String(from + i).padStart(2, "0")}`, content: `fact ${from + i}` }));
  const mkItem = (id: string, kind: string) => ({ id, title: id, kind, stage: "in_build", body: "" });

  function setup(opts: { mode?: "fold" | "append"; appendResult?: () => AppendRecordResult } = {}) {
    const calls: Array<{ id: string; lines: RecordAppendLine[] }> = [];
    const steps: string[] = [];
    const queue: RawObs[][] = [];
    const inner = new InMemoryWorkRecordStore({ "work-t1": mkItem("work-t1", "task"), "work-f1": mkItem("work-f1", "feature") });
    const store = Object.assign(Object.create(inner) as InMemoryWorkRecordStore, {
      appendRecord: async (id: string, lines: RecordAppendLine[]) => {
        calls.push({ id, lines });
        return opts.appendResult ? opts.appendResult() : inner.appendRecord(id, lines);
      },
    });
    const engine = {
      call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
        steps.push(step);
        if (step === "classify") return schema.parse({ observations: queue.shift() ?? [] });
        if (step === "workLog") return schema.parse({ lines: [{ kind: "change", text: "did a thing", from: ["o1"] }] });
        if (step === "workRecord") return schema.parse({ decisions: [], changes: [], findings: [], problems: [] });
        throw new Error(`unexpected step ${step}`);
      },
    } as unknown as Engine;
    let clock = Date.parse("2026-10-19T10:00:00Z");
    let bound: { taskId: string; featureId?: string } = { taskId: "work-t1", featureId: "work-f1" };
    const orch = createOrchestrator(engine, makeRuntime(cwd), {
      consolidateAtPoolTokens: 1e9, denRoot: cwd, workLog: opts.mode ?? "append", now: () => clock,
      getBoundWork: () => bound, workRecordStore: store,
    });
    return {
      orch, calls, steps, inner,
      feed: async (o: RawObs[]) => { queue.push(o); await orch.processChunks([chunk]); },
      advance: (ms: number) => { clock += ms; },
      bind: (b: typeof bound) => { bound = b; },
    };
  }

  it("fold mode never appends: the Record is rewritten as before", async () => {
    const t = setup({ mode: "fold" });
    await t.feed(obs(2));
    await t.orch.consolidateNow();
    expect(t.calls).toEqual([]);
    expect(t.steps).toContain("workRecord");
    expect(t.steps).not.toContain("workLog");
  });

  it("flushes a task's log at the 6th pending observation, not before, and only on the task", async () => {
    const t = setup();
    await t.feed(obs(5));
    expect(t.calls).toEqual([]);
    expect(t.orch.getActiveObservations()).toHaveLength(5);
    await t.feed(obs(1, 5));
    expect(t.calls.map((c) => c.id)).toEqual(["work-t1"]);
    expect(t.steps).not.toContain("workRecord");
    expect(t.orch.getActiveObservations()).toEqual([]);
    expect((await t.inner.get("work-f1"))!.body).toBe("");
  });

  it("flushes a single observation once it is 10 minutes old", async () => {
    const t = setup();
    await t.feed(obs(1));
    t.advance(9 * 60_000);
    await t.feed([]);
    expect(t.calls).toEqual([]);
    t.advance(60_000);
    await t.feed([]);
    expect(t.calls.map((c) => c.id)).toEqual(["work-t1"]);
  });

  it("routes feature-only observations to the feature's own log", async () => {
    const t = setup();
    t.bind({ taskId: "work-f1" });
    await t.feed(obs(6));
    expect(t.calls.map((c) => c.id)).toEqual(["work-f1"]);
  });

  it("flushWorkLog flushes below the thresholds", async () => {
    const t = setup();
    await t.feed(obs(2));
    expect(t.calls).toEqual([]);
    await t.orch.flushWorkLog();
    expect(t.calls.map((c) => c.id)).toEqual(["work-t1"]);
    expect(t.orch.getActiveObservations()).toEqual([]);
  });

  it("a written batch is archived with its target; a pending one stays in the pool", async () => {
    const ok = setup();
    await ok.feed(obs(2));
    await ok.orch.flushWorkLog();
    expect(readArchive(cwd).map((e) => [e.outcome, e.target])).toEqual([["written", "work-t1"], ["written", "work-t1"]]);

    const full = setup({ appendResult: () => ({ ok: false, code: "log_full" }) });
    await full.feed(obs(2));
    await full.orch.flushWorkLog();
    expect(full.orch.getActiveObservations()).toHaveLength(2);
  });
});
