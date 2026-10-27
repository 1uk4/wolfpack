/** Ask card end to end over /v1: real pi-durable turns, scripted model (no LLM). */
import { afterEach, describe, expect, it } from "vitest";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { NotFoundError, ProtocolError } from "@wolfpack/client";
import { adaptToDurable } from "../adapters/durable.js";
import { createAskUserQuestionExtension } from "../extensions/ask-user-question.js";
import { cardResult } from "../engine/cards.js";
import { fauxAssistantMessage, fauxToolCall } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const lastUserText = (context: { messages: { role: string; content: unknown }[] }): string => {
  const u = context.messages.filter((m) => m.role === "user").at(-1);
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};

describe("ask card (tool-raised, two-turn)", () => {
  it("free-text: tool raises a card -> turn ends complete -> needs-you -> answer starts the next turn -> idle", async () => {
    let seen = "";
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxToolCall("ask_user_question", { question: "Which branch?", details: "for the release" })], { stopReason: "toolUse" }),
        (context) => {
          seen = lastUserText(context as never);
          return fauxAssistantMessage("Shipping from main.");
        },
      ],
      hooks: { extensions: [adaptToDurable(createAskUserQuestionExtension(), { wolfDen: "/tmp", wolfName: "testwolf" })] },
    });
    const home = tw.home;
    expect((await tw.client.listThreads("testwolf"))[0].status).toBe("idle");

    const events = await tw.submit("release it");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    expect(tw.scripted.faux.state.callCount).toBe(1); // terminate: no second model request

    const detail = await tw.client.getThread(home);
    expect(detail.busy).toBe(false);
    expect(detail.status).toBe("needs-you");
    expect(detail.pendingCards).toHaveLength(1);
    const pending = detail.pendingCards![0];
    expect(pending.card).toMatchObject({ tool: "ask_user_question", fields: [{ id: "answer", kind: "free-text", label: "Which branch?", description: "for the release" }] });
    expect((await tw.client.listThreads("testwolf"))[0].status).toBe("needs-you");
    expect(await tw.client.listCards!("testwolf")).toEqual([pending]);
    const call = detail.messages.at(-1)!.tools![0];
    expect(call).toMatchObject({ name: "ask_user_question", callId: pending.callId, card: pending.card });
    expect(call.answer).toBeUndefined();

    const ack = await tw.client.answerCard!(home, pending.callId, { answer: { value: "main" } });
    expect(ack.disposition).toBe("started");
    for await (const e of tw.client.watch(home)) if (e.type === "turn-end") expect(e.reason).toBe("complete");

    expect(seen).toContain("main");
    expect(seen).toContain(pending.callId);
    const after = await tw.client.getThread(home);
    expect(after.status).toBe("idle");
    expect(after.pendingCards).toBeUndefined();
    const answered = after.messages.flatMap((m) => m.tools ?? []).find((t) => t.callId === pending.callId)!;
    expect(answered.answer).toEqual({ answer: { value: "main" } });
    expect(answered.result).toBe("main");
    expect(after.messages.at(-1)).toMatchObject({ role: "assistant", text: "Shipping from main." });
    expect(after.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["release it"]);
    expect(await tw.client.listCards!("testwolf")).toEqual([]);

    await expect(tw.client.answerCard!(home, pending.callId, { answer: { value: "again" } })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("single: validates the answer against the options; an Other answer is accepted", async () => {
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage(
          [fauxToolCall("ask_user_question", { question: "Pick", options: [{ label: "A (Recommended)", value: "a" }, { label: "B" }] })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("ok"),
      ],
      hooks: { extensions: [adaptToDurable(createAskUserQuestionExtension(), { wolfDen: "/tmp", wolfName: "testwolf" })] },
    });
    await tw.submit("go");
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    expect(p.card.fields[0]).toMatchObject({ kind: "single", options: [{ label: "A (Recommended)", value: "a" }, { label: "B", value: "B" }] });

    await expect(tw.client.answerCard!(tw.home, p.callId, {})).rejects.toBeInstanceOf(ProtocolError);
    await expect(tw.client.answerCard!(tw.home, p.callId, { answer: { value: "zzz" } })).rejects.toBeInstanceOf(ProtocolError);
    expect((await tw.client.getThread(tw.home)).status).toBe("needs-you"); // rejected answers change nothing

    await tw.client.answerCard!(tw.home, p.callId, { answer: { value: "something else", other: true } });
    for await (const _ of tw.client.watch(tw.home));
    const done = await tw.client.getThread(tw.home);
    expect(done.status).toBe("idle");
    expect(done.messages.flatMap((m) => m.tools ?? [])[0].answer).toEqual({ answer: { value: "something else", other: true } });
  });

  it("any durable tool can raise a card through the control channel (card result + terminate)", async () => {
    const confirm = defineExtension({
      name: "raiser",
      tools: [
        defineTool({
          name: "raise",
          description: "raise a card",
          parameters: { type: "object" as const, properties: {}, required: [] },
          async execute() {
            return cardResult({ tool: "raise", title: "T", fields: [{ id: "x", kind: "free-text", label: "x?" }] });
          },
        }),
      ],
    });
    tw = await startTestWolf({ script: [fauxAssistantMessage([fauxToolCall("raise", {})], { stopReason: "toolUse" })], hooks: { extensions: [confirm] } });
    const events = await tw.submit("do it");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    const d = await tw.client.getThread(tw.home);
    expect(d.status).toBe("needs-you");
    expect(d.pendingCards![0].card.title).toBe("T");
  });

  it("sibling cards of one turn: no turn until the last is answered, then one turn carries both", async () => {
    let seen = "";
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage([fauxToolCall("ask_user_question", { question: "Q1" }), fauxToolCall("ask_user_question", { question: "Q2" })], { stopReason: "toolUse" }),
        (context) => {
          seen = lastUserText(context as never);
          return fauxAssistantMessage("ok");
        },
      ],
      hooks: { extensions: [adaptToDurable(createAskUserQuestionExtension(), { wolfDen: "/tmp", wolfName: "testwolf" })] },
    });
    await tw.submit("go");
    const cards = (await tw.client.getThread(tw.home)).pendingCards!;
    expect(cards).toHaveLength(2);
    const first = await tw.client.answerCard!(tw.home, cards[0].callId, { answer: { value: "one" } });
    expect(first.disposition).toBe("queued");
    expect(tw.scripted.faux.state.callCount).toBe(1);
    expect((await tw.client.getThread(tw.home)).pendingCards).toHaveLength(1);
    const second = await tw.client.answerCard!(tw.home, cards[1].callId, { answer: { value: "two" } });
    expect(second.disposition).toBe("started");
    for await (const _ of tw.client.watch(tw.home));
    expect(seen).toContain("one");
    expect(seen).toContain("two");
    expect((await tw.client.getThread(tw.home)).status).toBe("idle");
  });
});
