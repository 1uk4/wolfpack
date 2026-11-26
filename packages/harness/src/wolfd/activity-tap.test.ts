import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityTap, type TapThread } from "./activity-tap.js";

const threads: Record<string, TapThread> = {
  t1: { id: "t1", kind: "feature", title: "Fix the thing", boundWorkItem: "work-wolfpack-abc" },
  c1: { id: "c1", kind: "subagent", title: "wolfd-Abc", parentThreadId: "t1", state: "running" },
};

function setup() {
  const emitted: { verb: string; actor: Record<string, unknown>; target?: Record<string, unknown> }[] = [];
  const tap = new ActivityTap({ emit: (d) => void emitted.push(d as never) }, (id) => threads[id], 30_000);
  return { tap, emitted };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ActivityTap", () => {
  it("thread busy sends thread-active with its work item, heartbeats every 30 s, and idle stops it", () => {
    const { tap, emitted } = setup();
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "busy" });
    expect(emitted[0]).toMatchObject({ verb: "thread-active", actor: { kind: "thread", threadId: "t1", title: "Fix the thing" }, target: { kind: "work-item", id: "work-wolfpack-abc" } });
    vi.advanceTimersByTime(60_000);
    expect(emitted.map((e) => e.verb)).toEqual(["thread-active", "thread-active", "thread-active"]);
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "idle" });
    vi.advanceTimersByTime(120_000);
    expect(emitted.map((e) => e.verb)).toEqual(["thread-active", "thread-active", "thread-active", "thread-idle"]);
  });

  it("a removed (closed) thread stops its heartbeat and forgets its bound item", () => {
    const { tap, emitted } = setup();
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "busy" });
    tap.onWolfEvent({ type: "thread-updated", thread: { id: "t1", kind: "feature", title: "x", boundWorkItem: "work-a-1" } });
    tap.onWolfEvent({ type: "thread-updated", thread: { id: "t1", kind: "feature", title: "x", boundWorkItem: "work-a-1", closed: true } });
    emitted.length = 0;
    vi.advanceTimersByTime(120_000);
    expect(emitted).toEqual([]);
    // forgotten: the same id coming back with the same item is a fresh bind
    tap.onWolfEvent({ type: "thread-updated", thread: { id: "t1", kind: "feature", title: "x", boundWorkItem: "work-a-1" } });
    expect(emitted.map((e) => e.verb)).toEqual(["bound"]);
  });

  it("a busy thread that disappears from the registry stops heartbeating", () => {
    const live: Record<string, TapThread> = { g1: { id: "g1", kind: "feature", title: "G" } };
    const emitted: { verb: string }[] = [];
    const tap = new ActivityTap({ emit: (d) => void emitted.push(d as never) }, (id) => live[id], 30_000);
    tap.onWolfEvent({ type: "thread-status", threadId: "g1", status: "busy" });
    delete live.g1;
    vi.advanceTimersByTime(30_000);
    emitted.length = 0;
    vi.advanceTimersByTime(120_000);
    expect(emitted).toEqual([]);
  });

  it("an idle status for a thread that never went busy sends nothing", () => {
    const { tap, emitted } = setup();
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "idle" });
    expect(emitted).toEqual([]);
  });

  it("bound and unbound follow the thread's bound work item", () => {
    const { tap, emitted } = setup();
    tap.onWolfEvent({ type: "thread-updated", thread: { id: "t2", kind: "home", title: "Home" } });
    tap.onWolfEvent({ type: "thread-updated", thread: { id: "t2", kind: "home", title: "Home", boundWorkItem: "work-x-1" } });
    tap.onWolfEvent({ type: "thread-updated", thread: { id: "t2", kind: "home", title: "Home", boundWorkItem: "work-x-1" } });
    tap.onWolfEvent({ type: "thread-updated", thread: { id: "t2", kind: "home", title: "Home" } });
    expect(emitted.map((e) => [e.verb, e.target?.id])).toEqual([["bound", "work-x-1"], ["unbound", "work-x-1"]]);
  });

  it("a subagent spawn and finish carry the subagent actor and the parent thread as target", () => {
    const { tap, emitted } = setup();
    tap.onWolfEvent({ type: "thread-updated", thread: { ...threads.c1 } });
    tap.onWolfEvent({ type: "thread-updated", thread: { ...threads.c1 } });
    tap.onWolfEvent({ type: "thread-updated", thread: { ...threads.c1, state: "done" } });
    expect(emitted.map((e) => e.verb)).toEqual(["subagent-spawned", "subagent-finished"]);
    expect(emitted[0]).toMatchObject({ actor: { kind: "subagent", subagent: "wolfd-Abc", parentThreadId: "t1" }, target: { kind: "thread", id: "t1" } });
  });

  it("cards raised and settled send needs-you and answered for the thread", () => {
    const { tap, emitted } = setup();
    tap.onWolfEvent({ type: "card-pending", card: { callId: "k", threadId: "t1" } });
    tap.onWolfEvent({ type: "card-settled", threadId: "t1", callId: "k", outcome: "answered" });
    expect(emitted.map((e) => [e.verb, e.actor.threadId])).toEqual([["needs-you", "t1"], ["answered", "t1"]]);
  });

  it("kb-read comes only from the read tool on a kb-mirror entry; bash is never inspected", () => {
    const { tap, emitted } = setup();
    tap.onToolStart("t1", "read", { path: "/h/kb-mirror/domains/wolfpack/entries/Ab12.md" });
    tap.onToolStart("t1", "read", { path: "/h/kb-mirror/domains/wolfpack/INDEX.md" });
    tap.onToolStart("t1", "bash", { command: "cat /h/kb-mirror/domains/wolfpack/entries/Zz.md" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ verb: "kb-read", target: { kind: "kb-entry", id: "Ab12", domain: "wolfpack" } });
  });
});
