/** Skip / supersede over /v1: real pi-durable turns, scripted model (no LLM). */
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError } from "@wolfpack/client";
import { fauxAssistantMessage, fauxToolCall } from "./scripted-model.js";
import { startTestWolf, type TestWolf, type TestWolfOptions } from "./test-wolf.js";
import { answerText, stripSupersededNotes, supersededNotes } from "./cards.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const lastUserText = (context: { messages: { role: string; content: unknown }[] }): string => {
  const u = context.messages.filter((m) => m.role === "user").at(-1);
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};
const wolf = (script: TestWolfOptions["script"]) => startTestWolf({ script });
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const drain = async (w: TestWolf) => {
  for await (const _ of w.client.watch(w.home));
};
const callsOf = async (w: TestWolf) => (await w.client.getThread(w.home)).messages.flatMap((m) => m.tools ?? []);

describe("skip a card", () => {
  it("tells the model, starts the next turn, ends idle; history says skipped; a second skip/answer is 404", async () => {
    let seen = "";
    tw = await wolf([
      toolUse(fauxToolCall("ask_user_question", { question: "Which branch?" })),
      (context) => {
        seen = lastUserText(context as never);
        return fauxAssistantMessage("Fine, I will pick.");
      },
    ]);
    await tw.submit("release it");
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    const ack = await tw.client.skipCard!(tw.home, p.callId);
    expect(ack.disposition).toBe("started");
    await drain(tw);
    expect(seen).toBe(`The user skipped your ask_user_question question (call ${p.callId}).`);
    const d = await tw.client.getThread(tw.home);
    expect(d.status).toBe("idle");
    expect(d.pendingCards).toBeUndefined();
    const call = (await callsOf(tw)).find((c) => c.callId === p.callId)!;
    expect(call).toMatchObject({ closed: "skipped", dismissed: true, result: "(skipped by the user)" });
    expect(call.answer).toBeUndefined();
    expect(d.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["release it"]);
    await expect(tw.client.skipCard!(tw.home, p.callId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(tw.client.answerCard!(tw.home, p.callId, { answer: { value: "late" } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(tw.client.skipCard!(tw.home, "no-such-call")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a skip announces card-settled dismissed with closed:skipped", async () => {
    tw = await wolf([toolUse(fauxToolCall("ask_user_question", { question: "Q" })), fauxAssistantMessage("ok")]);
    await tw.submit("go");
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    const seen: unknown[] = [];
    const ac = new AbortController();
    void (async () => {
      for await (const ev of tw!.client.watchActivity!("testwolf", { signal: ac.signal })) if (ev.type === "card-settled") seen.push(ev);
    })();
    await new Promise((r) => setTimeout(r, 100));
    await tw.client.skipCard!(tw.home, p.callId);
    await drain(tw);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    expect(seen).toMatchObject([{ callId: p.callId, outcome: "dismissed", closed: "skipped" }]);
  });

  it("siblings: an answer and a skip make one turn that lists both in raise order", async () => {
    let seen = "";
    tw = await wolf([
      toolUse(fauxToolCall("ask_user_question", { question: "Q1" }), fauxToolCall("ask_user_question", { question: "Q2" })),
      (context) => {
        seen = lastUserText(context as never);
        return fauxAssistantMessage("ok");
      },
    ]);
    await tw.submit("go");
    const cards = (await tw.client.getThread(tw.home)).pendingCards!;
    // Skip the FIRST one first: it is held, not submitted.
    expect((await tw.client.skipCard!(tw.home, cards[0].callId)).disposition).toBe("queued");
    expect(tw.scripted.faux.state.callCount).toBe(1);
    const mid = await tw.client.getThread(tw.home);
    expect(mid.status).toBe("needs-you");
    expect(mid.pendingCards!.map((p) => p.heldSkip)).toEqual([true, undefined]);
    expect((await tw.client.answerCard!(tw.home, cards[1].callId, { answer: { value: "two" } })).disposition).toBe("started");
    await drain(tw);
    expect(seen).toBe(`The user skipped your ask_user_question question (call ${cards[0].callId}).\nThe user answered your ask_user_question question (call ${cards[1].callId}):\n- Q2: two`);
    const calls = await callsOf(tw);
    expect(calls.map((c) => c.closed)).toEqual(["skipped", "answered"]);
    expect((await tw.client.getThread(tw.home)).status).toBe("idle");
  });

  it("a held skip can be replaced by an answer before the turn starts", async () => {
    let seen = "";
    tw = await wolf([
      toolUse(fauxToolCall("ask_user_question", { question: "Q1" }), fauxToolCall("ask_user_question", { question: "Q2" })),
      (context) => {
        seen = lastUserText(context as never);
        return fauxAssistantMessage("ok");
      },
    ]);
    await tw.submit("go");
    const cards = (await tw.client.getThread(tw.home)).pendingCards!;
    await tw.client.skipCard!(tw.home, cards[0].callId);
    await tw.client.answerCard!(tw.home, cards[0].callId, { answer: { value: "changed my mind" } });
    expect((await tw.client.getThread(tw.home)).pendingCards![0]).toMatchObject({ heldAnswer: { answer: { value: "changed my mind" } } });
    await tw.client.skipCard!(tw.home, cards[1].callId);
    await drain(tw);
    expect(seen).toContain("- Q1: changed my mind");
    expect(seen).toContain(`The user skipped your ask_user_question question (call ${cards[1].callId}).`);
  });
});

describe("superseded by a plain message", () => {
  it("the model is told which cards were replaced; history says superseded and hides the note", async () => {
    let seen = "";
    tw = await wolf([
      toolUse(fauxToolCall("ask_user_question", { question: "Q" })),
      (context) => {
        seen = lastUserText(context as never);
        return fauxAssistantMessage("never mind then");
      },
    ]);
    await tw.submit("go");
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    await tw.submit("do X instead");
    expect(seen).toBe(`(Your pending ask_user_question question (call ${p.callId}) was superseded by this message.)\n\ndo X instead`);
    const d = await tw.client.getThread(tw.home);
    expect(d.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["go", "do X instead"]);
    expect((await callsOf(tw)).find((c) => c.callId === p.callId)).toMatchObject({ closed: "superseded", dismissed: true });
    // a message with no pending cards carries no note
    tw.scripted.faux.appendResponses([fauxAssistantMessage("fine")]);
    await tw.submit("and again");
    expect(seen).toBe(`(Your pending ask_user_question question (call ${p.callId}) was superseded by this message.)\n\ndo X instead`);
  });
});

describe("unit", () => {
  it("answerText / superseded notes round-trip", () => {
    const card = { tool: "t", fields: [{ id: "a", kind: "free-text" as const, label: "A" }] };
    expect(answerText([{ callId: "c1", card, answers: {}, skipped: true }])).toBe("The user skipped your t question (call c1).");
    const notes = supersededNotes([{ callId: "c1", threadId: "x", card, raisedAt: "now" }, { callId: "c2", threadId: "x", card, raisedAt: "now" }]);
    expect(stripSupersededNotes(`${notes}hello\n\nworld`)).toBe("hello\n\nworld");
    expect(stripSupersededNotes("plain")).toBe("plain");
    expect(supersededNotes([])).toBe("");
  });
});
