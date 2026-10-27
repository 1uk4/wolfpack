/** Needs-you events over /v1: card events on the thread stream, status + card changes on the wolf activity stream. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WolfEvent } from "@wolfpack/protocol";
import { fauxAssistantMessage, fauxToolCall } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
let stop: AbortController | undefined;
afterEach(async () => {
  stop?.abort();
  stop = undefined;
  await tw?.stop();
  tw = undefined;
});

const ask = (...questions: string[]) => fauxAssistantMessage(questions.map((q) => fauxToolCall("ask_user_question", { question: q })), { stopReason: "toolUse" });
const drain = async (w: TestWolf) => {
  for await (const _ of w.client.watch(w.home));
};

/** Follow the wolf's activity stream into an array. */
function follow(w: TestWolf): WolfEvent[] {
  const seen: WolfEvent[] = [];
  stop = new AbortController();
  void (async () => {
    for await (const ev of w.client.watchActivity("testwolf", { signal: stop!.signal })) seen.push(ev);
  })().catch(() => {});
  return seen;
}
const summary = (events: readonly WolfEvent[]) =>
  events.map((e) => (e.type === "thread-status" ? `status:${e.status}` : e.type === "card-settled" ? `settled:${e.outcome}` : e.type));

describe("card events on the thread stream", () => {
  it("card-pending arrives before turn-end", async () => {
    tw = await startTestWolf({ script: [ask("Which branch?"), fauxAssistantMessage("done")] });
    const events = await tw.submit("release it");
    const types = events.map((e) => e.type);
    const pendingAt = types.indexOf("card-pending");
    expect(pendingAt).toBeGreaterThan(-1);
    expect(pendingAt).toBeLessThan(types.indexOf("turn-end"));
    const raised = events[pendingAt];
    if (raised.type !== "card-pending") throw new Error("unreachable");
    expect(raised.card).toMatchObject({ threadId: tw.home, card: { tool: "ask_user_question" } });
  });
});

describe("wolf activity stream", () => {
  it("baseline, then status and card transitions through raise -> answer", async () => {
    tw = await startTestWolf({ script: [ask("Which branch?"), fauxAssistantMessage("done")] });
    const seen = follow(tw);
    await vi.waitFor(() => expect(summary(seen)).toEqual(["status:idle"]));

    await tw.submit("release it");
    await vi.waitFor(() => expect(summary(seen)).toEqual(["status:idle", "status:busy", "card-pending", "status:needs-you"]));
    const pending = seen.find((e) => e.type === "card-pending");
    if (pending?.type !== "card-pending") throw new Error("no card");

    await tw.client.answerCard!(tw.home, pending.card.callId, { answer: { value: "main" } });
    await drain(tw);
    await vi.waitFor(() => expect(summary(seen).at(-1)).toBe("status:idle"));
    // needs-you goes straight to busy: never an idle blip between the answer and the next turn.
    expect(summary(seen).slice(4)).toEqual(["status:busy", "settled:answered", "status:idle"]);
    const ids = seen.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("a fresh connection starts with the pending cards as its baseline", async () => {
    tw = await startTestWolf({ script: [ask("Q1", "Q2")] });
    await tw.submit("go");
    const seen = follow(tw);
    await vi.waitFor(() => expect(summary(seen)).toEqual(["status:needs-you", "card-pending", "card-pending"]));
  });

  it("a held answer re-announces the card with it; a plain submit dismisses the cards", async () => {
    tw = await startTestWolf({ script: [ask("Q1", "Q2")] });
    await tw.submit("go");
    const cards = (await tw.client.getThread(tw.home)).pendingCards!;
    const seen = follow(tw);
    await vi.waitFor(() => expect(seen).toHaveLength(3));

    await tw.client.answerCard!(tw.home, cards[0].callId, { answer: { value: "one" } });
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    expect(seen[3]).toMatchObject({ type: "card-pending", card: { callId: cards[0].callId, heldAnswer: { answer: { value: "one" } } } });

    tw.scripted.faux.appendResponses([fauxAssistantMessage("never mind")]);
    await tw.submit("skip those");
    await vi.waitFor(() => expect(summary(seen).slice(4).filter((s) => s.startsWith("settled"))).toEqual(["settled:dismissed", "settled:dismissed"]));
    await vi.waitFor(() => expect(summary(seen).at(-1)).toBe("status:idle"));
  });

  /** Open the activity stream (optionally with a cursor) and read `n` frames: their events and SSE ids. */
  const readActivity = async (w: TestWolf, n: number, cursor?: string) => {
    const ctl = new AbortController();
    const res = await fetch(`${w.url}/v1/wolves/testwolf/activity`, {
      headers: { Accept: "text/event-stream", ...(cursor === undefined ? {} : { "Last-Event-ID": cursor }) },
      signal: ctl.signal,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const frames = () => text.split("\n\n").filter((f) => f.includes("data: "));
    while (frames().length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    ctl.abort();
    const fr = frames().slice(0, n);
    return {
      ids: fr.map((f) => /^id: (.*)$/m.exec(f)?.[1] ?? ""),
      events: fr.map((f) => JSON.parse(/^data: (.*)$/m.exec(f)![1]!) as WolfEvent),
    };
  };

  it("resumes from Last-Event-ID without a gap; a stale cursor gets resync + baseline", async () => {
    tw = await startTestWolf({ script: [ask("Q"), fauxAssistantMessage("x")] });
    const first = await readActivity(tw, 1);
    expect(first.events).toMatchObject([{ type: "thread-status", status: "idle" }]);
    expect(first.ids[0]).toMatch(/^[0-9a-f]+:\d+$/);
    await tw.submit("go");
    // Everything after the baseline cursor is replayed in order, nothing duplicated.
    const replayed = await readActivity(tw, 3, first.ids[0]);
    expect(summary(replayed.events)).toEqual(["status:busy", "card-pending", "status:needs-you"]);
    const boot = first.ids[0]!.split(":")[0];
    expect(summary((await readActivity(tw, 3, `${boot}:9999`)).events)).toEqual(["resync", "status:needs-you", "card-pending"]);
    expect(summary((await readActivity(tw, 3, "garbage")).events)).toEqual(["resync", "status:needs-you", "card-pending"]);
  });

  it("a restarted wolf (new process epoch) answers an old cursor with resync + baseline", async () => {
    tw = await startTestWolf({ script: [ask("Q")] });
    await tw.submit("go");
    const old = (await readActivity(tw, 1)).ids[0]!;
    await tw.stop();
    tw = await startTestWolf({ script: [ask("Q")] });
    // Same sequence number, other epoch: must not be trusted as a position.
    expect(summary((await readActivity(tw, 2, old)).events)).toEqual(["resync", "status:idle"]);
  });
});
