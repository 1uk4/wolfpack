import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, ThreadEvent } from "@wolfpack/protocol";
import { CARD_DETAILS_KEY } from "../engine/index.js";
import { ThreadRuntime } from "./thread.js";

/** A fake engine whose queued steers are withdrawn on abort, like pi-durable's. */
function fakeEngine(snapshotExtra: Record<string, unknown> = {}) {
  const queue: unknown[][] = [];
  let wake: (() => void) | undefined;
  let nextId = 1;
  const queued: number[] = [];
  const submitted: Array<{ input: unknown; whenBusy: string; cardAnswers?: unknown }> = [];
  const state = { runId: null as number | null, failSubmits: 0, attempts: 0, gate: undefined as Promise<void> | undefined, stopped: false };
  const push = (b: unknown[]) => { queue.push(b); wake?.(); };
  const conv = {
    id: "1",
    async submit({ input, whenBusy, cardAnswers }: { input: unknown; whenBusy: string; cardAnswers?: unknown }) {
      state.attempts++;
      if (state.failSubmits > 0) { state.failSubmits--; throw new Error("engine down"); }
      submitted.push({ input, whenBusy, cardAnswers });
      const id = nextId++;
      if (state.runId === null) {
        state.runId = id;
        push([{ type: "submission", record: { type: "input", status: "placed", id } }, { type: "run_start", inputs: [id] }, { type: "turn_start" }]);
        return { messageId: String(id), disposition: "started" };
      }
      queued.push(id);
      push([{ type: "submission", record: { type: "input", status: "queued", id } }]);
      if (state.gate) await state.gate;
      return { messageId: String(id), disposition: whenBusy === "steer" ? "steered" : "queued" };
    },
    async abort() {
      const id = state.runId;
      state.runId = null;
      const out: unknown[] = [{ type: "turn_end" }, { type: "run_end", inputs: [id] }, { type: "submission", record: { type: "input", status: "unanswered", reason: "aborted", id } }];
      for (const q of queued.splice(0)) out.push({ type: "submission", record: { type: "input", status: "unanswered", reason: "aborted", id: q } });
      push(out);
    },
    async watch() {
      if (snapshotExtra.run) state.runId = 1;
      return {
        snapshot: { type: "snapshot", entries: [], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} }, ...snapshotExtra },
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
  return { conv, push, submitted, state };
}

const card: Card = { tool: "ask", fields: [{ id: "answer", kind: "free-text", label: "Q" }] };
const toolEntry = (id: number, callId: string) =>
  ({ id, kind: "pi.tool_result", model: [{ role: "toolResult", toolCallId: callId, toolName: "ask", content: [], timestamp: 1, details: { [CARD_DETAILS_KEY]: card } }] }) as never;

async function rig(callIds: string[]) {
  const eng = fakeEngine({ run: { inputs: [1] }, entries: callIds.map((c, i) => toolEntry(10 + i, c)) });
  const events: ThreadEvent[] = [];
  const host = { name: "w", settleMs: 200, closing: () => false, emitWolf() {}, onError() {}, stallTimeoutMs: 0 } as never;
  const rt = new ThreadRuntime({ id: "w/home" } as never, eng.conv as never, host);
  rt.observe((e) => events.push(e));
  await rt.attach();
  return { eng, rt, events };
}
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("card answers while a turn runs", () => {
  it("is steered into the running turn, settles the card, no busy error", async () => {
    const { eng, rt, events } = await rig(["a"]);
    expect(rt.isRunning).toBe(true);
    const ack = await rt.answerCard("a", { answer: { value: "blue" } });
    expect(ack.disposition).toBe("steered");
    expect(eng.submitted.at(-1)).toMatchObject({ whenBusy: "steer", cardAnswers: { cards: [{ callId: "a" }] } });
    expect(rt.detail().pendingCards).toBeUndefined();
    expect(events.some((e) => e.type === "card-settled" && e.callId === "a" && e.closed === "answered")).toBe(true);
  });

  it("skip mid-turn is steered too", async () => {
    const { eng, rt } = await rig(["a"]);
    const ack = await rt.skipCard("a");
    expect(ack.disposition).toBe("steered");
    expect(eng.submitted.at(-1)).toMatchObject({ whenBusy: "steer", cardAnswers: { cards: [{ callId: "a", skipped: true }] } });
  });

  it("concurrent answers for one card claim it once", async () => {
    const { eng, rt } = await rig(["a"]);
    const r = await Promise.allSettled([rt.answerCard("a", { answer: { value: "1" } }), rt.answerCard("a", { answer: { value: "2" } })]);
    expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(eng.submitted.length).toBe(1);
  });

  it("an abort withdraws the steered answer; it is re-sent as a card answer, not as chat text", async () => {
    const { eng, rt } = await rig(["a"]);
    await rt.answerCard("a", { answer: { value: "blue" } });
    await rt.abort();
    await tick(10);
    expect(eng.submitted.length).toBe(2);
    const resent = eng.submitted[1];
    expect(resent).toMatchObject({ whenBusy: "followUp", cardAnswers: { cards: [{ callId: "a", answers: { answer: { value: "blue" } } }] } });
    expect(String(resent.input)).toContain("blue");
  });

  it("a resend that fails twice puts the card back as pending, with an error that says so", async () => {
    const { eng, rt, events } = await rig(["a"]);
    await rt.answerCard("a", { answer: { value: "blue" } });
    eng.state.failSubmits = 2;
    await rt.abort();
    await tick(100);
    const errs = events.filter((e) => e.type === "error").map((e) => (e as { message: string }).message);
    expect(errs).toHaveLength(2);
    expect(errs[1]).toContain("answer it again");
    expect(rt.detail().pendingCards?.map((c) => c.callId)).toEqual(["a"]);
    expect(events.filter((e) => e.type === "card-pending" && e.card.callId === "a").length).toBe(1);
    const ack = await rt.answerCard("a", { answer: { value: "green" } });
    expect(["started", "steered", "queued"]).toContain(ack.disposition);
    expect(eng.submitted.at(-1)?.cardAnswers).toMatchObject({ cards: [{ callId: "a", answers: { answer: { value: "green" } } }] });
  });

  it("a placed answer is not re-sent by a later abort", async () => {
    const { eng, rt } = await rig(["a"]);
    await rt.answerCard("a", { answer: { value: "blue" } });
    eng.push([{ type: "submission", record: { type: "input", status: "placed", id: 1 } }]);
    await tick(10);
    await rt.abort();
    await tick(10);
    expect(eng.submitted.length).toBe(1);
  });
});

describe("a chat message mid-turn", () => {
  it("supersedes pending cards as soon as the engine accepts it", async () => {
    const { rt, events } = await rig(["a", "b"]);
    await rt.submit("change of plan", "steer");
    expect(rt.detail().pendingCards).toBeUndefined();
    expect(events.filter((e) => e.type === "card-settled" && e.closed === "superseded").map((e) => (e as { callId: string }).callId)).toEqual(["a", "b"]);
    await expect(rt.answerCard("a", { answer: { value: "x" } })).rejects.toMatchObject({ code: "not_found" });
    await expect(rt.skipCard("b")).rejects.toMatchObject({ code: "not_found" });
  });

  it("an answer in flight is not superseded by a chat message accepted meanwhile: it ends answered, closed once", async () => {
    const { eng, rt, events } = await rig(["a"]);
    // The answer's submit stalls in the engine (the claim is held) while the chat message is accepted.
    let release!: () => void;
    eng.state.gate = new Promise<void>((r) => (release = r));
    const answering = rt.answerCard("a", { answer: { value: "blue" } });
    await tick(1);
    eng.state.gate = undefined;
    await rt.submit("change of plan", "steer");
    expect(events.some((e) => e.type === "card-settled" && e.closed === "superseded")).toBe(false);
    release();
    await answering;
    const closes = events.filter((e) => e.type === "card-settled" && e.callId === "a");
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ closed: "answered" });
    expect(rt.detail().pendingCards).toBeUndefined();
  });

  it("superseding discards a held sibling answer loudly", async () => {
    const { rt, events } = await rig(["a", "b"]);
    await rt.answerCard("a", { answer: { value: "one" } }); // held: b still waits
    await rt.submit("never mind", "steer");
    const msg = events.filter((e) => e.type === "error").map((e) => (e as { message: string }).message).join("\n");
    expect(msg).toContain("saved answer");
    expect(msg).toContain("a");
    expect(events.filter((e) => e.type === "card-settled" && e.closed === "superseded")).toHaveLength(2);
  });

  it("a rejected submit leaves the cards answerable", async () => {
    const { eng, rt } = await rig(["a"]);
    eng.state.failSubmits = 1;
    await expect(rt.submit("x", "steer")).rejects.toBeDefined();
    expect(rt.detail().pendingCards).toHaveLength(1);
  });

  it("internal and resubmitted messages do not supersede", async () => {
    const { rt } = await rig(["a"]);
    await rt.submit("delivery", "steer", [], { internal: true });
    expect(rt.detail().pendingCards).toHaveLength(1);
  });
});
