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
  it("announces the wolf at start and every 60 s, idle or busy, on an unref'd timer; stop sends wolf-offline", () => {
    const { tap, emitted } = setup();
    const spy = vi.spyOn(globalThis, "setInterval");
    tap.startWolfBeat("hal");
    expect(emitted).toMatchObject([{ verb: "wolf-online", actor: { kind: "wolf", wolf: "hal" } }]);
    vi.advanceTimersByTime(125_000);
    expect(emitted.map((e) => e.verb)).toEqual(["wolf-online", "wolf-online", "wolf-online"]);
    expect((spy.mock.results.at(-1)!.value as { hasRef(): boolean }).hasRef()).toBe(false);
    tap.stop();
    expect(emitted.at(-1)).toMatchObject({ verb: "wolf-offline", actor: { kind: "wolf", wolf: "hal" } });
    const n = emitted.length;
    vi.advanceTimersByTime(300_000);
    expect(emitted.length).toBe(n);
  });

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

  it("a thread busy in one long tool call keeps heartbeating: 65 s with no other events gives two heartbeats", () => {
    const { tap, emitted } = setup();
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "busy" });
    tap.onToolStart("t1", "bash", { command: "sleep 100" });
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "busy" }); // a repeated busy must not reset or double the timer
    emitted.length = 0;
    vi.advanceTimersByTime(65_000);
    expect(emitted.map((e) => e.verb)).toEqual(["thread-active", "thread-active"]);
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

  it("each KB tool shape maps to its target: entry read, INDEX/_digest read and bash grep/cat give entry or domain; kb_* args name entry, section or domain", () => {
    const { tap, emitted } = setup();
    const kb = "/h/kb-mirror/domains/wolfpack";
    tap.onToolStart("t1", "read", { path: `${kb}/entries/Ab12.md` });
    tap.onToolStart("t1", "read", { path: `${kb}/INDEX.md` });
    tap.onToolStart("t1", "read", { path: `${kb}/_digest.json` }); // same domain target within 30 s: deduped
    tap.onToolStart("t1", "bash", { command: `cat ${kb}/entries/Zz.md | head -5` });
    tap.onToolStart("t1", "bash", { command: `grep -ril "graph" ${kb}/entries/ | head` }); // domain again: deduped
    tap.onToolStart("t1", "kb_access", { entryId: "E9", domain: "personal" });
    tap.onToolStart("t1", "kb_access", { sectionId: "S1", domain: "personal" });
    tap.onToolStart("t1", "kb_access", { domain: "spot" });
    expect(emitted.map((e) => [e.verb, e.target!.kind, e.target!.id, e.target!.domain])).toEqual([
      ["kb-read", "kb-entry", "Ab12", "wolfpack"],
      ["kb-read", "domain", "wolfpack", "wolfpack"],
      ["kb-read", "kb-entry", "Zz", "wolfpack"],
      ["kb-read", "kb-entry", "E9", "personal"],
      ["kb-read", "kb-section", "S1", "personal"],
      ["kb-read", "domain", "spot", "spot"],
    ]);
  });

  it("non-KB paths and commands emit nothing, and a bash command with no read verb or that redirects into the KB is ignored", () => {
    const { tap, emitted } = setup();
    tap.onToolStart("t1", "read", { path: "/h/src/entries/Ab12.md" });
    tap.onToolStart("t1", "bash", { command: "ls /h/src && cat README.md" });
    tap.onToolStart("t1", "bash", { command: "echo hi > /h/kb-mirror/domains/wolfpack/entries/Zz.md" });
    tap.onToolStart("t1", "kb_access", { note: "no ids" });
    const kb = "/h/kb-mirror/domains/wolfpack/entries/Zz.md";
    for (const command of [`rm ${kb}`, `sed -i 's/a/b/' ${kb}`, `cat x | tee ${kb}`, `cp /tmp/a ${kb}`, `mv ${kb} /tmp/b`, `grep a ${kb} && rm ${kb}`]) {
      tap.onToolStart("t1", "bash", { command });
      tap.onToolStart("c1", "guarded_bash", { command });
    }
    expect(emitted).toEqual([]);
  });

  it("a sub-agent's read-only tools (guarded_bash, grep, find, ls) emit kb-read with the subagent actor; non-KB paths emit nothing", () => {
    const { tap, emitted } = setup();
    const kb = "/h/kb-mirror/domains/wolfpack";
    tap.onToolStart("c1", "guarded_bash", { command: `cat ${kb}/entries/X.md` });
    tap.onToolStart("c1", "grep", { pattern: "graph", path: "/h/kb-mirror/domains/spot/entries" });
    tap.onToolStart("c1", "find", { pattern: "*.md", path: "/h/kb-mirror/domains/personal" });
    tap.onToolStart("c1", "ls", { path: `${kb}/entries` });
    tap.onToolStart("c1", "grep", { pattern: "x", path: "/h/src" });
    tap.onToolStart("c1", "ls", {});
    expect(emitted.map((e) => [e.verb, e.actor.kind, e.target!.kind, e.target!.id, e.target!.domain])).toEqual([
      ["kb-read", "subagent", "kb-entry", "X", "wolfpack"],
      ["kb-read", "subagent", "domain", "spot", "spot"],
      ["kb-read", "subagent", "domain", "personal", "personal"],
      ["kb-read", "subagent", "domain", "wolfpack", "wolfpack"],
    ]);
  });

  it("work-item tools send work-touch for the item they name (id, ids, else the bound one); sub-agents are attributed; create, query, bind and unknown ids send nothing", () => {
    const { tap, emitted } = setup();
    tap.onToolStart("t1", "task_note", { id: "work-wolfpack-AAA", note: "secret text" });
    tap.onToolStart("t1", "task_stage", { stage: "in_build" }); // defaults to the bound item
    tap.onToolStart("t1", "task_done", { ids: ["work-wolfpack-B1", "work-spot-B2"] });
    tap.onToolStart("c1", "task_update", { id: "work-wolfpack-CCC" });
    tap.onToolStart("t1", "task_create", { title: "x" });
    tap.onToolStart("t1", "task_query", { current: true });
    tap.onToolStart("t1", "task_bind", { id: "work-wolfpack-DDD" });
    tap.onToolStart("t1", "task_claim", {}); // no id, claim has no default
    expect(emitted.map((e) => [e.verb, e.actor.kind, e.target])).toEqual([
      ["work-touch", "thread", { kind: "work-item", id: "work-wolfpack-AAA", domain: "wolfpack" }],
      ["work-touch", "thread", { kind: "work-item", id: "work-wolfpack-abc", domain: "wolfpack" }],
      ["work-touch", "thread", { kind: "work-item", id: "work-wolfpack-B1", domain: "wolfpack" }],
      ["work-touch", "thread", { kind: "work-item", id: "work-spot-B2", domain: "spot" }],
      ["work-touch", "subagent", { kind: "work-item", id: "work-wolfpack-CCC", domain: "wolfpack" }],
    ]);
    expect(JSON.stringify(emitted)).not.toContain("secret text");
  });

  it("work-touch is throttled on its own: the same item once per 30 s per thread, at most 10 per turn, a new turn resets the cap", () => {
    const { tap, emitted } = setup();
    const note = (id: string) => tap.onToolStart("t1", "task_note", { id: `work-wolfpack-${id}` });
    note("A");
    note("A");
    expect(emitted).toHaveLength(1);
    vi.advanceTimersByTime(31_000);
    note("A");
    expect(emitted).toHaveLength(2);
    for (let i = 0; i < 25; i++) note(`W${i}`);
    expect(emitted).toHaveLength(10);
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "idle" });
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "busy" });
    emitted.length = 0;
    note("Fresh");
    expect(emitted.map((e) => e.verb)).toEqual(["work-touch"]);
  });

  it("the same target is sent once per 30 s per thread, and a turn sends at most 10 kb-reads", () => {
    const { tap, emitted } = setup();
    const p = (id: string) => ({ path: `/h/kb-mirror/domains/d/entries/${id}.md` });
    tap.onToolStart("t1", "read", p("A"));
    tap.onToolStart("t1", "read", p("A"));
    vi.advanceTimersByTime(31_000);
    tap.onToolStart("t1", "read", p("A"));
    expect(emitted).toHaveLength(2);
    for (let i = 0; i < 25; i++) tap.onToolStart("t1", "read", p(`E${i}`));
    expect(emitted).toHaveLength(10); // 2 above + 8 more: the turn's cap
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "idle" });
    tap.onWolfEvent({ type: "thread-status", threadId: "t1", status: "busy" }); // a new turn resets the cap
    emitted.length = 0;
    tap.onToolStart("t1", "read", p("Fresh"));
    expect(emitted.map((e) => e.verb)).toEqual(["kb-read"]);
  });
});
