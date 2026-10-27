/** SweepManager -> MemoryEvents: lazy sweep_started, always-paired sweep_finished, the persisted last sweep, and the idle-tick fix. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelTable } from "@wolfpack/engine";
import type { SweepResult, SweepTickOptions, SweepTickResult } from "@wolfpack/kb/librarian";
import { MemoryEventSchema, type MemoryEvent } from "@wolfpack/protocol";
import { SweepManager } from "./sweep-worker.js";
import { memoryEventsFor } from "./memory/events.js";

const emptyResult = (): SweepResult => ({ processed: 0, created: 0, merged: 0, rejected: 0, errors: 0, unclassified: 0, touchedDomains: [], failures: [], parked: [], remaining: 0 });

describe("SweepManager events", () => {
  let base: string;
  let events: MemoryEvent[];
  let off: () => void;
  let next: (o: SweepTickOptions) => Promise<SweepTickResult>;
  let mgr: SweepManager;
  const lastFile = () => join(base, "den", "sweep-last.json");

  const tick = async () => {
    await mgr.start();
    while (mgr.isRunning()) await new Promise((r) => setTimeout(r, 5));
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-worker-events-"));
    events = [];
    off = memoryEventsFor(base, "dewey").subscribe((e) => events.push(e));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mgr = new SweepManager({
      kbBase: join(base, "kb"), kbOps: join(base, "ops"), denLocal: join(base, "den"),
      models: { tiers: {} } as unknown as ModelTable,
      emit: (d) => memoryEventsFor(base, "dewey").emit(d),
      sweepTick: (o) => next(o),
    });
  });
  afterEach(() => {
    off();
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it("maps a real run to sweep_started, sweep_item, sweep_finished and persists the last sweep", async () => {
    next = async (o) => {
      o.onEvent?.({ type: "started", pending: 3 });
      o.onEvent?.({ type: "item", from: "w1", denTopicId: "alpha", outcome: "create", entryId: "kb-wp-AAAAAAA" });
      return { outcome: "ran", sweep: { ...emptyResult(), processed: 1, created: 1, remaining: 2 } };
    };
    await tick();
    expect(events.map((e) => e.type)).toEqual(["sweep_started", "sweep_item", "sweep_finished"]);
    expect(events[0]).toMatchObject({ wolf: "dewey", pending: 3 });
    expect(events[1]).toMatchObject({ from: "w1", denTopicId: "alpha", outcome: "create", entryId: "kb-wp-AAAAAAA" });
    expect(events[2]).toMatchObject({ processed: 1, created: 1, merged: 0, rejected: 0, parked: 0, remaining: 2 });
    for (const e of events) expect(MemoryEventSchema.safeParse(e).success).toBe(true);
    const saved = JSON.parse(readFileSync(lastFile(), "utf8"));
    expect(saved).toMatchObject({ processed: 1, created: 1, remaining: 2 });
    expect(saved.error).toBeUndefined();
  });

  it("an idle tick emits nothing, writes nothing, and keeps the last run in the status", async () => {
    next = async (o) => {
      o.onEvent?.({ type: "started", pending: 1 });
      return { outcome: "ran", sweep: { ...emptyResult(), processed: 1, merged: 1 } };
    };
    await tick();
    events.length = 0;

    next = async () => ({ outcome: "idle", sweep: emptyResult() });
    await tick();
    expect(events).toEqual([]);
    const st = mgr.getStatus();
    expect(st.state).toBe("idle");
    expect(st.completedAt).toBeDefined();
    expect(st.result).toMatchObject({ processed: 1, merged: 1 });
    expect(JSON.parse(readFileSync(lastFile(), "utf8")).finishedAt).toBe(st.completedAt);
  });

  it("never started and idle: no last sweep file, bare idle status", async () => {
    next = async () => ({ outcome: "idle", sweep: emptyResult() });
    await tick();
    expect(events).toEqual([]);
    expect(existsSync(lastFile())).toBe(false);
    expect(mgr.getStatus()).toEqual({ state: "idle" });
  });

  it("a throw after sweep_started still emits sweep_finished with the error, and persists it", async () => {
    next = async (o) => {
      o.onEvent?.({ type: "started", pending: 2 });
      throw new Error("engine exploded\nsecond line");
    };
    await tick();
    expect(events.map((e) => e.type)).toEqual(["sweep_started", "sweep_finished"]);
    expect(events[1]).toMatchObject({ processed: 0, error: "engine exploded" });
    expect(JSON.parse(readFileSync(lastFile(), "utf8")).error).toBe("engine exploded");
    expect(mgr.getStatus()).toMatchObject({ state: "failed", error: "engine exploded\nsecond line" });
  });

  it("a throw before any work emits nothing", async () => {
    next = async () => { throw new Error("no engine"); };
    await tick();
    expect(events).toEqual([]);
  });
});
