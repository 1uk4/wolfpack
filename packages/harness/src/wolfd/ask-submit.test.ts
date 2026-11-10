/** The questionnaire's save / note / submit rules on a thread, against a fake conversation (no model): error codes and what is announced. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stepsKey, type Card, type PendingCard, type ThreadEvent } from "@wolfpack/protocol";
import { CARD_DETAILS_KEY } from "../engine/index.js";
import { askCard } from "../extensions/ask.js";
import { ThreadRuntime } from "./thread.js";

/** A running turn that accepts steers; `gate` holds a submit in flight. */
function fakeEngine(entries: unknown[]) {
  const queue: unknown[][] = [];
  let wake: (() => void) | undefined;
  let nextId = 1;
  const submitted: Array<{ input: unknown; whenBusy: string; cardAnswers?: unknown }> = [];
  const state = { gate: undefined as Promise<void> | undefined, stopped: false };
  const push = (b: unknown[]) => { queue.push(b); wake?.(); };
  const conv = {
    id: "1",
    async submit({ input, whenBusy, cardAnswers }: { input: unknown; whenBusy: string; cardAnswers?: unknown }) {
      submitted.push({ input, whenBusy, cardAnswers });
      const id = nextId++;
      push([{ type: "submission", record: { type: "input", status: "queued", id } }]);
      if (state.gate) await state.gate;
      return { messageId: String(id), disposition: "steered" };
    },
    async abort() {},
    async watch() {
      return {
        snapshot: { type: "snapshot", run: { inputs: [1] }, entries, tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } },
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
  return { conv, submitted, state };
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

  it("refuses a page or goto out of range, a note over the image cap, and a stepsKey of other pages", async () => {
    const { rt } = await rig();
    expect(await code(() => rt.saveCardPage("k", 2, { answers: {} }))).toBe("invalid_request");
    expect(await code(() => rt.saveCardPage("k", 0, { answers: {}, goto: 5 }))).toBe("invalid_request");
    expect(await code(() => rt.putCardNote("k", { attachments: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }))).toBe("invalid_request");
    expect(await code(() => rt.saveCardPage("k", 0, { answers: {}, stepsKey: "a|b" }))).toBe("conflict");
    expect(await code(() => rt.saveCardPage("k", 0, { answers: {}, stepsKey: stepsKey(card) }))).toBe("ok");
  });

  it("is 404 for an unknown card and after a plain message superseded the set", async () => {
    const { rt } = await rig();
    expect(await code(rt.submitCard("nope", {}))).toBe("not_found");
    await rt.submit("never mind", "steer");
    expect(await code(rt.submitCard("k", { answers: { a: { value: "x" }, c: { value: "y" } } }))).toBe("not_found");
    expect(await code(() => rt.putCardNote("k", { text: "n" }))).toBe("not_found");
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
    release();
    await first;
    expect(eng.submitted).toHaveLength(1); // one delivery
    expect(eng.submitted[0].cardAnswers).toMatchObject({ cards: [{ callId: "k", answers: { a: { value: "x" }, c: { value: "y" } } }] });
  });
});
