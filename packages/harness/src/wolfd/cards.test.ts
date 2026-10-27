/** Ask card end to end over /v1: real pi-durable turns, scripted model (no LLM). */
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { BusyError, HttpConsoleClient, NotFoundError, ProtocolError } from "@wolfpack/client";
import type { Card } from "@wolfpack/protocol";
import { Type } from "../extension-api.js";
import { adaptToDurable } from "../adapters/durable.js";
import { cardResult, createCardGuardExtension } from "../engine/cards.js";
import { fauxAssistantMessage, fauxToolCall } from "./scripted-model.js";
import type { ExtensionRuntime } from "./run.js";
import { WolfServer } from "./server.js";
import { startTestWolf, type TestWolf, type TestWolfOptions } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const lastUserText = (context: { messages: { role: string; content: unknown }[] }): string => {
  const u = context.messages.filter((m) => m.role === "user").at(-1);
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};

// wolfd installs ask_user_question and the card guard itself (run.ts).
const wolfWithAsk = (script: TestWolfOptions["script"], more: Extension[] = []) => startTestWolf({ script, hooks: { extensions: more } });
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const drain = async (w: TestWolf) => {
  for await (const _ of w.client.watch(w.home));
};

describe("ask card (tool-raised, two-turn)", () => {
  it("free-text: tool raises a card -> turn ends complete -> needs-you -> answer starts the next turn -> idle", async () => {
    let seen = "";
    tw = await wolfWithAsk([
      toolUse(fauxToolCall("ask_user_question", { question: "Which branch?", details: "for the release" })),
      (context) => {
        seen = lastUserText(context as never);
        return fauxAssistantMessage("Shipping from main.");
      },
    ]);
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
    await drain(tw);

    expect(seen).toContain("- Which branch?: main");
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

  it("single: validates answers against the options; an Other answer is accepted", async () => {
    tw = await wolfWithAsk([
      toolUse(fauxToolCall("ask_user_question", { question: "Pick", options: [{ label: "A (Recommended)", value: "a" }, { label: "B" }] })),
      fauxAssistantMessage("ok"),
    ]);
    await tw.submit("go");
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    expect(p.card.fields[0]).toMatchObject({ kind: "single", options: [{ label: "A (Recommended)", value: "a" }, { label: "B", value: "B" }] });

    const invalid: Record<string, { value: string; other?: boolean }>[] = [{}, { answer: { value: "zzz" } }, { answer: { value: "  ", other: true } }, { answer: { value: "a" }, extra: { value: "x" } }];
    for (const bad of invalid) {
      await expect(tw.client.answerCard!(tw.home, p.callId, bad)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect((await tw.client.getThread(tw.home)).status).toBe("needs-you"); // rejected answers change nothing

    await tw.client.answerCard!(tw.home, p.callId, { answer: { value: "something else", other: true } });
    await drain(tw);
    const done = await tw.client.getThread(tw.home);
    expect(done.status).toBe("idle");
    expect(done.messages.flatMap((m) => m.tools ?? [])[0].answer).toEqual({ answer: { value: "something else", other: true } });
  });

  it("rejects `other` on a free-text field and on a single field with allowOther:false; unknown callId is 404", async () => {
    const strict: Card = { tool: "strict", fields: [{ id: "x", kind: "single", label: "x?", allowOther: false, options: [{ label: "yes", value: "yes" }] }] };
    const raiser = defineExtension({
      name: "raiser",
      tools: [
        defineTool({ name: "raise_strict", description: "raise", parameters: { type: "object" as const, properties: {}, required: [] }, async execute() { return cardResult(strict); } }),
      ],
    });
    tw = await wolfWithAsk([toolUse(fauxToolCall("raise_strict", {})), toolUse(fauxToolCall("ask_user_question", { question: "free?" }))], [raiser]);
    await tw.submit("one");
    const [strictP] = (await tw.client.getThread(tw.home)).pendingCards!;
    await expect(tw.client.answerCard!(tw.home, strictP.callId, { x: { value: "mine", other: true } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(tw.client.answerCard!(tw.home, "no-such-call", { x: { value: "yes" } })).rejects.toBeInstanceOf(NotFoundError);
    await tw.client.answerCard!(tw.home, strictP.callId, { x: { value: "yes" } });
    await drain(tw);
    const [freeP] = (await tw.client.getThread(tw.home)).pendingCards!;
    expect(freeP.card.fields[0].kind).toBe("free-text");
    await expect(tw.client.answerCard!(tw.home, freeP.callId, { answer: { value: "t", other: true } })).rejects.toBeInstanceOf(ProtocolError);
    expect((await tw.client.getThread(tw.home)).status).toBe("needs-you");
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
    tw = await startTestWolf({ script: [toolUse(fauxToolCall("raise", {}))], hooks: { extensions: [confirm] } });
    const events = await tw.submit("do it");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    const d = await tw.client.getThread(tw.home);
    expect(d.status).toBe("needs-you");
    expect(d.pendingCards![0].card.title).toBe("T");
  });

  it("a card beside another tool in the same round still ends the run (no second model request)", async () => {
    let echoed = 0;
    const echo = defineExtension({
      name: "echo",
      tools: [defineTool({ name: "echo", description: "echo", parameters: { type: "object" as const, properties: {}, required: [] }, async execute() { echoed++; return { output: [{ type: "text" as const, text: "echoed" }] }; } })],
    });
    tw = await wolfWithAsk([toolUse(fauxToolCall("ask_user_question", { question: "Q" }), fauxToolCall("echo", {})), fauxAssistantMessage("must not run")], [echo]);
    const events = await tw.submit("go");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    expect(echoed).toBe(1);
    expect(tw.scripted.faux.state.callCount).toBe(1);
    const d = await tw.client.getThread(tw.home);
    expect(d.status).toBe("needs-you");
    expect(d.pendingCards).toHaveLength(1);
  });

  describe("sibling cards of one turn", () => {
    const twoCards = () =>
      wolfWithAsk([
        toolUse(fauxToolCall("ask_user_question", { question: "Q1" }), fauxToolCall("ask_user_question", { question: "Q2" })),
        fauxAssistantMessage("ok"),
      ]);

    it("no turn until the last is answered; the held answer is visible and changeable; the turn lists both in raise order", async () => {
      let seen = "";
      tw = await wolfWithAsk([
        toolUse(fauxToolCall("ask_user_question", { question: "Q1" }), fauxToolCall("ask_user_question", { question: "Q2" })),
        (context) => {
          seen = lastUserText(context as never);
          return fauxAssistantMessage("ok");
        },
      ]);
      await tw.submit("go");
      const cards = (await tw.client.getThread(tw.home)).pendingCards!;
      expect(cards).toHaveLength(2);
      // Answer the SECOND first: raise order still wins in the model's message.
      expect((await tw.client.answerCard!(tw.home, cards[1].callId, { answer: { value: "two-draft" } })).disposition).toBe("queued");
      expect(tw.scripted.faux.state.callCount).toBe(1);
      let d = await tw.client.getThread(tw.home);
      expect(d.status).toBe("needs-you");
      expect(d.pendingCards!.map((p) => p.heldAnswer)).toEqual([undefined, { answer: { value: "two-draft" } }]);
      expect((await tw.client.answerCard!(tw.home, cards[1].callId, { answer: { value: "two" } })).disposition).toBe("queued"); // changed
      expect((await tw.client.getThread(tw.home)).pendingCards![1].heldAnswer).toEqual({ answer: { value: "two" } });
      expect((await tw.client.answerCard!(tw.home, cards[0].callId, { answer: { value: "one" } })).disposition).toBe("started");
      await drain(tw);
      expect(seen.indexOf("- Q1: one")).toBeGreaterThan(-1);
      expect(seen.indexOf("- Q2: two")).toBeGreaterThan(seen.indexOf("- Q1: one"));
      d = await tw.client.getThread(tw.home);
      expect(d.status).toBe("idle");
      expect(d.messages.flatMap((m) => m.tools ?? []).map((t) => t.answer)).toEqual([{ answer: { value: "one" } }, { answer: { value: "two" } }]);
    });

    it("a plain submit supersedes pending cards and clears held answers; a later answer is 404", async () => {
      tw = await twoCards();
      await tw.submit("go");
      const cards = (await tw.client.getThread(tw.home)).pendingCards!;
      await tw.client.answerCard!(tw.home, cards[0].callId, { answer: { value: "one" } }); // held
      tw.scripted.faux.appendResponses([fauxAssistantMessage("never mind then")]);
      await tw.submit("skip those, do X instead");
      const d = await tw.client.getThread(tw.home);
      expect(d.status).toBe("idle");
      expect(d.pendingCards).toBeUndefined();
      expect(await tw.client.listCards!("testwolf")).toEqual([]);
      const calls = d.messages.flatMap((m) => m.tools ?? []);
      expect(calls.map((c) => [c.dismissed, c.answer])).toEqual([[true, undefined], [true, undefined]]);
      for (const c of cards) await expect(tw.client.answerCard!(tw.home, c.callId, { answer: { value: "late" } })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it("answering while a turn runs is 409 busy; the superseded card is then 404", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = defineExtension({
      name: "gate",
      tools: [defineTool({ name: "gate", description: "wait", parameters: { type: "object" as const, properties: {}, required: [] }, async execute() { await gate; return { output: [{ type: "text" as const, text: "open" }] }; } })],
    });
    tw = await wolfWithAsk([toolUse(fauxToolCall("ask_user_question", { question: "Q" })), toolUse(fauxToolCall("gate", {})), fauxAssistantMessage("done")], [slow]);
    await tw.submit("go");
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    await tw.client.submit(tw.home, "actually do this", { whenBusy: "reject" });
    expect((await tw.client.getThread(tw.home)).busy).toBe(true);
    await expect(tw.client.answerCard!(tw.home, p.callId, { answer: { value: "x" } })).rejects.toBeInstanceOf(BusyError);
    release();
    await drain(tw);
    const d = await tw.client.getThread(tw.home);
    expect(d.status).toBe("idle");
    expect(d.messages.flatMap((m) => m.tools ?? []).find((t) => t.callId === p.callId)).toMatchObject({ dismissed: true });
    await expect(tw.client.answerCard!(tw.home, p.callId, { answer: { value: "x" } })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a concurrent double answer for the same card starts exactly one turn", async () => {
    tw = await wolfWithAsk([toolUse(fauxToolCall("ask_user_question", { question: "Q" })), fauxAssistantMessage("ok")]);
    await tw.submit("go");
    const [p] = (await tw.client.getThread(tw.home)).pendingCards!;
    const results = await Promise.allSettled([
      tw.client.answerCard!(tw.home, p.callId, { answer: { value: "a" } }),
      tw.client.answerCard!(tw.home, p.callId, { answer: { value: "b" } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(NotFoundError);
    await drain(tw);
    expect(tw.scripted.faux.state.callCount).toBe(2);
  });

  it("a reconnecting wolfd re-derives pending cards from the durable transcript (CardTracker.reset)", async () => {
    tw = await wolfWithAsk([toolUse(fauxToolCall("ask_user_question", { question: "Q1", options: [{ label: "x" }] })), fauxAssistantMessage("ok")]);
    await tw.submit("go");
    const before = await tw.client.getThread(tw.home);
    expect(before.pendingCards).toHaveLength(1);
    // A second server attaches to the same engine conversation: its tracker is rebuilt from the snapshot's entries.
    const second = new WolfServer({ name: "testwolf", conversation: tw.wolf.conversation });
    await second.attach();
    const url = await second.listen();
    try {
      const c2 = new HttpConsoleClient({ baseUrl: url });
      const d = await c2.getThread(tw.home);
      expect(d.status).toBe("needs-you");
      expect(d.pendingCards).toEqual(before.pendingCards);
      expect(await c2.listCards("testwolf")).toEqual(before.pendingCards);
      await c2.answerCard(tw.home, before.pendingCards![0].callId, { answer: { value: "x" } });
      for await (const _ of c2.watch(tw.home));
      expect((await c2.getThread(tw.home)).status).toBe("idle");
    } finally {
      await second.close();
    }
  });

  it("a card tool in a loaded (adapted) extension is auto-detected by the guard", async () => {
    const mk = (rt: ExtensionRuntime) => adaptToDurable(
      {
        name: "loaded-ask",
        tools: [{ name: "loaded_ask", description: "ask", raisesCard: true, parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "asked" }], card: { tool: "loaded_ask", fields: [{ id: "a", kind: "free-text", label: "a?" }] } }; } }],
      },
      { wolfDen: rt.den, wolfName: "testwolf", onCardTool: rt.onCardTool },
    );
    const plain = defineExtension({ name: "plain", tools: [defineTool({ name: "plain", description: "p", parameters: { type: "object" as const, properties: {}, required: [] }, async execute() { return { output: [{ type: "text" as const, text: "p" }] }; } })] });
    tw = await startTestWolf({ script: [toolUse(fauxToolCall("loaded_ask", {}), fauxToolCall("plain", {})), fauxAssistantMessage("must not run")], hooks: { extensions: (rt) => [mk(rt), plain] } });
    await tw.submit("go");
    expect(tw.scripted.faux.state.callCount).toBe(1);
    expect((await tw.client.getThread(tw.home)).pendingCards).toHaveLength(1);
  });

  it("an erroring card tool does not terminate the round: the model sees the error and continues", async () => {
    const mk = (rt: ExtensionRuntime) => adaptToDurable(
      { name: "bad-ask", tools: [{ name: "bad_ask", description: "ask", raisesCard: true, parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "boom" }], isError: true }; } }] },
      { wolfDen: rt.den, wolfName: "testwolf", onCardTool: rt.onCardTool },
    );
    tw = await startTestWolf({ script: [toolUse(fauxToolCall("bad_ask", {})), fauxAssistantMessage("recovered")], hooks: { extensions: (rt) => [mk(rt)] } });
    await tw.submit("go");
    expect(tw.scripted.faux.state.callCount).toBe(2);
    const d = await tw.client.getThread(tw.home);
    expect(d.status).toBe("idle");
    expect(d.messages.at(-1)!.text).toContain("recovered");
  });

  it("card tool registries are per guard: a same-named tool registered on one guard is not a card tool for another", () => {
    const a = createCardGuardExtension();
    const b = createCardGuardExtension();
    const ext = { name: "x", tools: [{ name: "same", description: "d", raisesCard: true, parameters: Type.Object({}), async execute() { return { content: [] }; } }] };
    adaptToDurable(ext, { wolfDen: tmpdir(), wolfName: "w", onCardTool: a.register });
    expect(a.isCardTool("same")).toBe(true);
    expect(b.isCardTool("same")).toBe(false);
    expect(createCardGuardExtension(["native"]).isCardTool("native")).toBe(true);
  });
});
