/** Stepped / dependent cards (card.steps + field.showIf) over /v1: a hidden field is not required, and not accepted. */
import { afterEach, describe, expect, it } from "vitest";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Card, CardAnswers } from "@wolfpack/protocol";
import { cardResult } from "../engine/cards.js";
import { askCard } from "../extensions/ask-user-question.js";
import { fauxAssistantMessage, fauxToolCall } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";
import { answerText, validateAnswers } from "./cards.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const drain = async (w: TestWolf) => {
  for await (const _ of w.client.watch(w.home));
};
const lastUserText = (context: { messages: { role: string; content: unknown }[] }): string => {
  const u = context.messages.filter((m) => m.role === "user").at(-1);
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content);
};

/** The crawl interview shape: depth only matters for by-folder. */
const CRAWL: Card = askCard({
  title: "Crawl",
  questions: [
    { id: "source", question: "Source dir?" },
    { id: "strategy", question: "Strategy?", options: [{ label: "By folder", value: "by-folder" }, { label: "By pattern", value: "by-pattern" }] },
    { id: "depth", question: "Depth?", options: [{ label: "1" }, { label: "2" }], showIf: { field: "strategy", equals: "by-folder" } },
  ],
  steps: [{ title: "Source", questions: ["source"] }, { title: "Shape", questions: ["strategy", "depth"] }],
});

describe("validateAnswers with showIf (pure)", () => {
  const ok = (a: CardAnswers) => expect(validateAnswers(CRAWL, a)).toBeUndefined();
  const bad = (a: CardAnswers, re: RegExp) => expect(validateAnswers(CRAWL, a)).toMatch(re);

  it("the dependent field is required only while shown, and rejected while hidden", () => {
    ok({ source: { value: "/d" }, strategy: { value: "by-pattern" } });
    bad({ source: { value: "/d" }, strategy: { value: "by-pattern" }, depth: { value: "1" } }, /not shown/);
    bad({ source: { value: "/d" }, strategy: { value: "by-folder" } }, /missing answer for field "depth"/);
    ok({ source: { value: "/d" }, strategy: { value: "by-folder" }, depth: { value: "2" } });
    bad({ source: { value: "/d" }, strategy: { value: "by-folder" }, depth: { value: "9" } }, /not an option/);
    bad({ strategy: { value: "by-pattern" } }, /missing answer for field "source"/);
  });

  it("answerText lists only the visible questions", () => {
    const text = answerText([{ callId: "c", card: CRAWL, answers: { source: { value: "/d" }, strategy: { value: "by-pattern" } } }]);
    expect(text).toContain("- Strategy?: by-pattern");
    expect(text).not.toContain("Depth?");
  });
});

describe("stepped crawl card over /v1", () => {
  const raiser = defineExtension({
    name: "raiser",
    tools: [defineTool({ name: "raise", description: "raise", parameters: { type: "object" as const, properties: {} }, async execute() { return cardResult(CRAWL); } })],
  });

  it("one submission answers every step; the skipped dependent field needs no answer and is invalid if sent", async () => {
    let seen = "";
    tw = await startTestWolf({
      script: [
        toolUse(fauxToolCall("raise", {})),
        (context) => {
          seen = lastUserText(context as never);
          return fauxAssistantMessage("ok");
        },
      ],
      hooks: { extensions: [raiser] },
    });
    await tw.submit("go");
    const d0 = await tw.client.getThread(tw.home);
    expect(d0.status).toBe("needs-you");
    const [p] = d0.pendingCards!;
    expect(p.card.steps).toEqual([{ title: "Source", fields: ["source"] }, { title: "Shape", fields: ["strategy", "depth"] }]);
    expect(p.card.fields[2].showIf).toEqual({ field: "strategy", equals: "by-folder" });
    const calls = tw.scripted.faux.state.callCount;

    await expect(tw.client.answerCard!(tw.home, p.callId, { source: { value: "/d" }, strategy: { value: "by-pattern" }, depth: { value: "1" } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(tw.client.answerCard!(tw.home, p.callId, { source: { value: "/d" }, strategy: { value: "by-folder" } })).rejects.toMatchObject({ code: "invalid_request" });
    expect(tw.scripted.faux.state.callCount).toBe(calls);

    expect((await tw.client.answerCard!(tw.home, p.callId, { source: { value: "/d" }, strategy: { value: "by-pattern" } })).disposition).toBe("started");
    await drain(tw);
    expect(seen).toContain("- Source dir?: /d");
    expect(seen).toContain("- Strategy?: by-pattern");
    expect(seen).not.toContain("Depth?");
    const done = await tw.client.getThread(tw.home);
    expect(done.status).toBe("idle");
    const call = done.messages.flatMap((m) => m.tools ?? [])[0];
    expect(call.answer).toEqual({ source: { value: "/d" }, strategy: { value: "by-pattern" } });
    expect(call.result).toBe("/d; by-pattern");
  });
});
