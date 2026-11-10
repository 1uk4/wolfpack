/** The questionnaire's save / note / submit rules on a thread, against a fake conversation (no model): error codes and what is announced. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepsKey, type Card, type PendingCard, type ThreadEvent } from "@wolfpack/protocol";
import { CARD_DETAILS_KEY } from "../engine/index.js";
import { askCard } from "../extensions/ask.js";
import { ThreadRuntime } from "./thread.js";

/** A running turn that accepts steers; `gate` holds a submit in flight. */
function fakeEngine(entries: unknown[], idle = false) {
  const queue: unknown[][] = [];
  let wake: (() => void) | undefined;
  let nextId = 1;
  const submitted: Array<{ input: unknown; whenBusy: string; cardAnswers?: unknown }> = [];
  const queued: number[] = [];
  const state = { gate: undefined as Promise<void> | undefined, stopped: false, failSubmits: 0 };
  const push = (b: unknown[]) => { queue.push(b); wake?.(); };
  const conv = {
    id: "1",
    async submit({ input, whenBusy, cardAnswers }: { input: unknown; whenBusy: string; cardAnswers?: unknown }) {
      if (state.failSubmits > 0) { state.failSubmits--; throw new Error("engine down"); }
      submitted.push({ input, whenBusy, cardAnswers });
      const id = nextId++;
      queued.push(id);
      push([{ type: "submission", record: { type: "input", status: "queued", id } }]);
      if (state.gate) await state.gate;
      return { messageId: String(id), disposition: "steered" };
    },
    async abort() {
      push([{ type: "turn_end" }, { type: "run_end", inputs: [1] }, ...queued.splice(0).map((id) => ({ type: "submission", record: { type: "input", status: "unanswered", reason: "aborted", id } }))]);
    },
    async watch() {
      return {
        snapshot: { type: "snapshot", ...(idle ? {} : { run: { inputs: [1] } }), entries, tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } },
        batches: (async function* () {
          while (true) {
            const n = queue.shift();
            if (n) yield n;
            else if (state.stopped) return;
            else await new Promise<void>((r) => (wake = r));
          }
        })(),
        stop: async () => { state.stopped = true; wake?.(); },
      };
    },
  };
  return { conv, submitted, state, push };
}

const q = (id: string, extra: object = {}) => ({ id, ask: id.toUpperCase(), kind: "free" as const, ...extra });
const card: Card = askCard({ pages: [{ title: "P1", questions: [q("a", { required: true }), q("b")] }, { title: "P2", questions: [q("c", { required: true })] }] });
const toolEntry = (callId: string, c: Card) =>
  ({ id: 10, kind: "pi.tool_result", model: [{ role: "toolResult", toolCallId: callId, toolName: "ask", content: [], timestamp: 1, details: { [CARD_DETAILS_KEY]: c } }] }) as never;

async function rig() {
  const eng = fakeEngine([toolEntry("k", card)]);
  const events: ThreadEvent[] = [];
  const host = { name: "w", settleMs: 200, closing: () => false, emitWolf() {}, onError() {}, stallTimeoutMs: 0, den: undefined } as never;
  const rt = new ThreadRuntime({ id: "w/home" } as never, eng.conv as never, host);
  rt.observe((e) => events.push(e));
  await rt.attach();
  return { eng, rt, events };
}
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const code = (p: Promise<unknown> | (() => unknown)) => Promise.resolve().then(typeof p === "function" ? p : () => p).then(() => "ok", (e: { code?: string }) => e.code);
const lastPending = (events: ThreadEvent[]) => [...events].reverse().find((e) => e.type === "card-pending") as { card: PendingCard } | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("questionnaire save, note and submit", () => {
  it("a submit missing required answers is one 400 naming every missing question by number and label", async () => {
    const { rt } = await rig();
    await expect(rt.submitCard("k", {})).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/Q1 "A", Q3 "C"/) });
  });

  it("after a save, card-pending carries pageIndex, reached, the saved answers and the note", async () => {
    const { rt, events } = await rig();
    rt.saveCardPage("k", 0, { answers: { a: { value: "x" } } });
    rt.putCardNote("k", { text: "careful" });
    expect(lastPending(events)!.card).toMatchObject({ callId: "k", pageIndex: 1, reached: 1, pageAnswers: { a: { value: "x" } }, note: { text: "careful" } });
  });

  it("refuses a page or goto out of range and a stepsKey of other pages", async () => {
    const { rt } = await rig();
    expect(await code(() => rt.saveCardPage("k", 2, { answers: {} }))).toBe("invalid_request");
    expect(await code(() => rt.saveCardPage("k", 0, { answers: {}, goto: 5 }))).toBe("invalid_request");
    expect(await code(() => rt.saveCardPage("k", 0, { answers: {}, stepsKey: "a|b" }))).toBe("conflict");
    expect(await code(() => rt.saveCardPage("k", 0, { answers: {}, stepsKey: stepsKey(card) }))).toBe("ok");
  });

  it("binding text is a 409 for a stepsKey of other pages and accepted for the current one", async () => {
    const { rt } = await rig();
    expect(await code(() => rt.bindCardText("k", "a", "typed", [], undefined, "a|b"))).toBe("conflict");
    expect(await code(() => rt.bindCardText("k", "a", "typed", [], undefined, stepsKey(card)))).toBe("ok");
  });

  it("is 404 for an unknown card and after a plain message superseded the set", async () => {
    const { rt } = await rig();
    expect(await code(rt.submitCard("nope", {}))).toBe("not_found");
    await rt.submit("never mind", "steer");
    expect(await code(rt.submitCard("k", { answers: { a: { value: "x" }, c: { value: "y" } } }))).toBe("not_found");
    expect(await code(() => rt.putCardNote("k", { text: "n" }))).toBe("not_found");
    expect(await code(() => rt.saveCardPage("k", 0, { answers: {} }))).toBe("not_found");
  });

  it("a second submit while the first is in flight is a 409 and delivers once", async () => {
    const { rt, eng } = await rig();
    let release!: () => void;
    eng.state.gate = new Promise<void>((r) => (release = r));
    rt.saveCardPage("k", 0, { answers: { a: { value: "x" } } });
    const first = rt.submitCard("k", { answers: { c: { value: "y" } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await code(rt.submitCard("k", { answers: { c: { value: "y" } } }))).toBe("conflict");
    expect(await code(() => rt.saveCardPage("k", 0, { answers: {} }))).toBe("conflict");
    expect(await code(() => rt.bindCardText("k", "a", "typed"))).toBe("conflict");
    release();
    await first;
    expect(eng.submitted).toHaveLength(1); // one delivery
    expect(eng.submitted[0].cardAnswers).toMatchObject({ cards: [{ callId: "k", answers: { a: { value: "x" }, c: { value: "y" } } }] });
  });

  it("an ask_revise rejected after the submit was claimed is still told to the agent", async () => {
    const { rt, eng } = await rig();
    let release!: () => void;
    eng.state.gate = new Promise<void>((r) => (release = r));
    rt.saveCardPage("k", 0, { answers: { a: { value: "x" } } });
    const sub = rt.submitCard("k", { answers: { c: { value: "y" } } });
    await tick(0);
    const rev = askCard({ pages: [{ title: "New", questions: [q("n1")] }] }, "k");
    eng.push([{ type: "message_end", entry: { ...(toolEntry("rev", rev) as object), id: 11 } }]);
    await tick(10);
    release();
    await sub;
    await tick(10);
    expect(JSON.stringify(eng.submitted.slice(1).map((s) => s.input))).toMatch(/ask_revise was NOT applied/);
  });

  it("a withdrawn submit that fails for good gives back the on-screen page's answers too", async () => {
    const { rt, eng } = await rig();
    rt.saveCardPage("k", 0, { answers: { a: { value: "x" } } });
    const sub = rt.submitCard("k", { answers: { c: { value: "y" } } }); // c was only on screen, never saved
    await tick(10);
    await sub;
    eng.state.failSubmits = 2;
    const ab = rt.abort();
    await tick(100);
    await ab;
    expect(rt.detail().pendingCards?.[0]).toMatchObject({ callId: "k", pageAnswers: { a: { value: "x" }, c: { value: "y" } } });
  });
});

/** A parent thread and a subagent child sharing one host, as wolfd wires them (ancestorsOf / descendantsOf by parentThreadId). */
async function family(opts: { parentCard?: boolean; grandchild?: boolean } = {}) {
  const threads = new Map<string, ThreadRuntime>();
  const wolfEvents: Array<{ type: string; [k: string]: unknown }> = [];
  const rel = (id: string, up: boolean): ThreadRuntime[] => {
    if (up) {
      const out: ThreadRuntime[] = [];
      for (let p = threads.get(id)?.summary.parentThreadId; p && threads.get(p); p = threads.get(p)?.summary.parentThreadId) out.push(threads.get(p) as ThreadRuntime);
      return out;
    }
    const kids = [...threads.values()].filter((t) => t.summary.parentThreadId === id);
    return [...kids, ...kids.flatMap((k) => rel(k.summary.id, false))];
  };
  const host = {
    name: "w", settleMs: 200, closing: () => false, emitWolf: (e: never) => void wolfEvents.push(e), onError() {}, stallTimeoutMs: 0, den: undefined,
    ancestorsOf: (id: string) => rel(id, true),
    descendantsOf: (id: string) => rel(id, false),
  } as never;
  const askEntry = (callId: string, ts: number) => ({ id: 10, kind: "pi.tool_result", model: [{ role: "toolResult", toolCallId: callId, toolName: "ask", content: [], timestamp: ts, details: { [CARD_DETAILS_KEY]: card } }] }) as never;
  const parentEng = fakeEngine(opts.parentCard ? [askEntry("pk", 3000)] : [], true);
  const parent = new ThreadRuntime({ id: "w/home", kind: "home", title: "home" } as never, parentEng.conv as never, host);
  threads.set("w/home", parent);
  const kidEng = fakeEngine([], true);
  const kid = new ThreadRuntime({ id: "w/kid", kind: "subagent", title: "ask-sheet", agent: "worker", parentThreadId: "w/home" } as never, kidEng.conv as never, host);
  threads.set("w/kid", kid);
  const grandEng = fakeEngine([], true);
  const grand = new ThreadRuntime({ id: "w/grand", kind: "subagent", title: "deep", agent: "worker", parentThreadId: "w/kid" } as never, grandEng.conv as never, host);
  if (opts.grandchild) threads.set("w/grand", grand);
  const parentEvents: ThreadEvent[] = [];
  parent.observe((e) => parentEvents.push(e));
  await parent.attach();
  await kid.attach();
  if (opts.grandchild) await grand.attach();
  /** The child raises an `ask` card live at timestamp `ts`. */
  const kidRaises = async (callId = "kk", ts = 2000) => {
    kidEng.push([{ type: "message_end", entry: askEntry(callId, ts) }]);
    await tick(10);
  };
  const grandRaises = async (callId = "gk", ts = 2500) => {
    grandEng.push([{ type: "message_end", entry: askEntry(callId, ts) }]);
    await tick(10);
  };
  return { parent, kid, grand, parentEng, kidEng, grandEng, parentEvents, wolfEvents, kidRaises, grandRaises };
}

describe("a subagent's questionnaire queues in the parent's sheet", () => {
  it("shows in the parent's pendingCards, stamped with its source and the child's threadId, oldest first", async () => {
    const f = await family({ parentCard: true });
    await f.kidRaises("kk", 2000); // raised before the parent's own card (timestamp 3000)
    expect(f.parent.detail().pendingCards?.map((c) => [c.callId, c.threadId, c.source])).toEqual([
      ["kk", "w/kid", { kind: "subagent", label: "worker: ask-sheet" }],
      ["pk", "w/home", { kind: "self", label: "you" }],
    ]);
  });

  it("is also announced on the parent stream and the wolf stream, and its settle too", async () => {
    const f = await family();
    await f.kidRaises();
    const raised = f.parentEvents.find((e) => e.type === "card-pending") as { card: PendingCard } | undefined;
    expect(raised?.card).toMatchObject({ callId: "kk", threadId: "w/kid", source: { kind: "subagent", label: "worker: ask-sheet" } });
    expect(f.wolfEvents.find((e) => e.type === "card-pending")).toMatchObject({ card: { callId: "kk", threadId: "w/kid" } });
    f.kid.saveCardPage("kk", 0, { answers: { a: { value: "x" } } });
    await f.kid.submitCard("kk", { answers: { c: { value: "y" } } });
    await tick(10);
    expect(f.parentEvents.find((e) => e.type === "card-settled")).toMatchObject({ callId: "kk", outcome: "answered" });
  });

  it("makes the parent needs-you while it is pending, and the child's own status stays idle", async () => {
    const f = await family();
    expect(f.parent.status()).toBe("idle");
    await f.kidRaises();
    expect(f.parent.status()).toBe("needs-you");
    expect(f.kid.status()).toBe("idle");
    expect(f.wolfEvents).toContainEqual({ type: "thread-status", threadId: "w/home", status: "needs-you" });
  });

  it("orders mixed Z and +00:00 raise times by the instant, not the text", async () => {
    const f = await family({ parentCard: true });
    await f.kidRaises("kk", 1000);
    // The parent's own card was raised at 3000 ms (…03.000Z); a +00:00 form of an earlier instant must still sort first.
    const kidCard = f.kid.cards.pending()[0] as PendingCard;
    f.kid.cards.pending = () => [{ ...kidCard, raisedAt: "1970-01-01T01:00:01+01:00" }]; // 1 s: text sorts after "…00:00:03.000Z", the instant before
    expect(f.parent.detail().pendingCards?.map((c) => c.callId)).toEqual(["kk", "pk"]);
    f.kid.cards.pending = () => [{ ...kidCard, raisedAt: "1969-12-31T23:00:05-01:00" }]; // 5 s: text sorts before, the instant after
    expect(f.parent.detail().pendingCards?.map((c) => c.callId)).toEqual(["pk", "kk"]);
  });

  it("a subagent with a card of its own child stays idle while its parent is needs-you", async () => {
    const f = await family({ grandchild: true });
    await f.grandRaises();
    expect(f.kid.status()).toBe("idle");
    expect(f.parent.status()).toBe("needs-you");
    expect(f.parent.detail().pendingCards?.map((c) => c.callId)).toEqual(["gk"]);
  });

  it("leaves the parent's needs-you once the child's card is answered", async () => {
    const f = await family();
    await f.kidRaises();
    expect(f.parent.status()).toBe("needs-you");
    f.kid.saveCardPage("kk", 0, { answers: { a: { value: "x" } } });
    await f.kid.submitCard("kk", { answers: { c: { value: "y" } } });
    await tick(10);
    expect(f.parent.detail().pendingCards).toBeUndefined();
    expect(f.parent.status()).not.toBe("needs-you");
  });

  it("stamps a tool confirmation with the tool's name as its source", async () => {
    const f = await family();
    f.kidEng.push([{ type: "message_end", entry: { id: 11, kind: "pi.tool_result", model: [{ role: "toolResult", toolCallId: "tc", toolName: "crawl_run", content: [], timestamp: 2000, details: { [CARD_DETAILS_KEY]: { ...card, tool: "crawl_run" } } }] } as never }]);
    await tick(10);
    expect(f.parent.detail().pendingCards?.[0]).toMatchObject({ callId: "tc", source: { kind: "tool", label: "crawl_run" } });
  });

  it("is left pending by a plain message to the parent, which dismisses only the parent's own card", async () => {
    const f = await family({ parentCard: true });
    await f.kidRaises();
    await f.parent.submit("never mind", "steer");
    await tick(10);
    expect(f.parent.detail().pendingCards?.map((c) => c.callId)).toEqual(["kk"]);
    expect(f.parentEvents.filter((e) => e.type === "card-settled")).toMatchObject([{ callId: "pk", closed: "superseded" }]);
  });

  it("settles as superseded on the parent stream when the child is discarded", async () => {
    const f = await family();
    await f.kidRaises();
    f.kid.supersedePending();
    expect(f.parentEvents.find((e) => e.type === "card-settled")).toMatchObject({ callId: "kk", outcome: "dismissed", closed: "superseded" });
    expect(f.parent.status()).toBe("idle");
  });
});
