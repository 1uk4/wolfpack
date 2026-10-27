import { describe, expect, it } from "vitest";
import type { Card } from "@wolfpack/protocol";
import { CARD_ANSWER_KIND, CARD_DETAILS_KEY } from "../engine/index.js";
import { CardTracker, answerText, validateAnswers } from "./cards.js";

const card = (label: string): Card => ({ tool: "ask_user_question", fields: [{ id: "answer", kind: "free-text", label }] });
const toolEntry = (id: number, callId: string, c: Card) =>
  ({ id, kind: "pi.tool_result", model: [{ role: "toolResult", toolCallId: callId, toolName: "ask_user_question", content: [], timestamp: 1, details: { [CARD_DETAILS_KEY]: c } }] }) as never;
const answerEntry = (id: number, callIds: string[]) => ({ id, kind: CARD_ANSWER_KIND, data: { cards: callIds.map((callId) => ({ callId, answers: {} })) } }) as never;
const userEntry = (id: number) => ({ id, kind: "pi.user", model: [{ role: "user", content: "hi" }] }) as never;

describe("CardTracker", () => {
  it("derives pending from entries: raised until answered", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "a", card("A")), toolEntry(2, "b", card("B")), answerEntry(3, ["a"])]);
    expect(t.pending().map((p) => p.callId)).toEqual(["b"]);
  });

  it("a plain user entry dismisses every pending card and held answer", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "a", card("A")), toolEntry(2, "b", card("B"))]);
    t.answer("a", { answer: { value: "x" } });
    expect(t.apply(userEntry(3))).toEqual(["a", "b"]);
    expect(t.pending()).toEqual([]);
    expect(t.get("a")).toBeUndefined();
  });

  it("holds answers until the last sibling, surfaces them, returns them in raise order", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "a", card("A")), toolEntry(2, "b", card("B"))]);
    expect(t.answer("b", { answer: { value: "B1" } })).toBeUndefined();
    expect(t.pending().map((p) => p.heldAnswer)).toEqual([undefined, { answer: { value: "B1" } }]);
    t.answer("b", { answer: { value: "B2" } });
    const ready = t.answer("a", { answer: { value: "A1" } })!;
    expect(ready.map((r) => [r.callId, r.answers.answer.value])).toEqual([["a", "A1"], ["b", "B2"]]);
    expect(t.pending()).toEqual([]); // claimed: a second answer finds nothing
    expect(t.get("a")).toBeUndefined();
  });

  it("release puts claimed cards back with their answers; settle drops them", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "a", card("A"))]);
    const ready = t.answer("a", { answer: { value: "x" } })!;
    t.release(ready.map((r) => r.callId));
    expect(t.pending()[0]).toMatchObject({ callId: "a", heldAnswer: { answer: { value: "x" } } });
    t.answer("a", { answer: { value: "y" } });
    t.settle(["a"]);
    expect(t.pending()).toEqual([]);
  });
});

describe("answerText / validateAnswers", () => {
  it("includes each field's label for every card", () => {
    const text = answerText([{ callId: "a", card: card("Which?"), answers: { answer: { value: "main" } } }]);
    expect(text).toBe("The user answered your ask_user_question question (call a):\n- Which?: main");
  });

  it("validates single options, other, and unknown fields", () => {
    const single: Card = { tool: "t", fields: [{ id: "x", kind: "single", label: "x", allowOther: false, options: [{ label: "y", value: "y" }] }] };
    expect(validateAnswers(single, { x: { value: "y" } })).toBeUndefined();
    expect(validateAnswers(single, { x: { value: "z", other: true } })).toMatch(/custom/);
    expect(validateAnswers(single, { x: { value: "z" } })).toMatch(/not an option/);
    expect(validateAnswers(single, { x: { value: "y" }, q: { value: "1" } })).toMatch(/unknown field/);
    expect(validateAnswers(card("A"), { answer: { value: "t", other: true } })).toMatch(/free text/);
  });
});
