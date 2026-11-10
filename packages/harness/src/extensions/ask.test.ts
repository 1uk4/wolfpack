import { describe, expect, it } from "vitest";
import { CardSchema } from "@wolfpack/protocol";
import { askProblem, askResult, reviseResult, type AskArgs, type AskQuestion } from "./ask.js";

const choice = { label: "A", value: "a", tradeoff: "fast but rigid" };
const single: AskQuestion = { id: "q1", ask: "Which?", kind: "single", choices: [choice, { label: "B", value: "b", tradeoff: "slow but flexible" }] };
const slider = (over: Partial<AskQuestion> = {}): AskQuestion => ({ id: "s", ask: "How many?", kind: "slider", min: 0, max: 10, step: 2, ...over });
const one = (...questions: AskQuestion[]): AskArgs => ({ pages: [{ title: "P1", questions }] });

describe("ask tool schema", () => {
  it("raises a paged card: pages become steps, questions skippable and Other offered by default", () => {
    const r = askResult({ pages: [{ title: "One", questions: [{ ...single, context: "## why" }] }, { title: "Two", questions: [{ id: "q2", ask: "Free?", kind: "free" }] }] });
    expect("card" in r).toBe(true);
    const card = CardSchema.parse("card" in r ? r.card : undefined);
    expect(card).toMatchObject({ tool: "ask", paged: true, steps: [{ title: "One", fields: ["q1"] }, { title: "Two", fields: ["q2"] }] });
    expect(card.fields[0]).toMatchObject({ id: "q1", description: "## why", optional: true, allowOther: true });
    expect((card.fields[0] as { options: unknown[] }).options[0]).toMatchObject({ value: "a", tradeoff: "fast but rigid" });
  });

  it("required and noOther switch the defaults off", () => {
    const card = CardSchema.parse((askResult(one({ ...single, required: true, noOther: true })) as { card: unknown }).card);
    expect(card.fields[0]).toMatchObject({ allowOther: false });
    expect(card.fields[0].optional).toBeUndefined();
  });

  it("rejects a single or multi question with no choices", () => {
    expect(askProblem(one({ ...single, choices: [] }))).toMatch(/kind "single" but has no choices/);
    expect(askProblem(one({ id: "m", ask: "Some?", kind: "multi" }))).toMatch(/kind "multi" but has no choices/);
  });

  it("rejects a choice without a tradeoff", () => {
    const q = { ...single, choices: [choice, { label: "B", value: "b", tradeoff: "  " }] };
    expect(askProblem(one(q))).toMatch(/choices\[1\].*non-empty `tradeoff`/);
    expect(askResult(one(q))).toMatchObject({ isError: true });
  });

  it("validates slider bounds, step and default", () => {
    expect(askProblem(one(slider()))).toBeUndefined();
    expect(askProblem(one(slider({ min: 5, max: 5 })))).toMatch(/min < max/);
    expect(askProblem(one(slider({ step: 0 })))).toMatch(/step > 0/);
    expect(askProblem(one(slider({ default: 12 })))).toMatch(/within min and max/);
    expect(askProblem(one(slider({ default: 3 })))).toMatch(/on a step/);
    expect(askProblem(one(slider({ default: 4 })))).toBeUndefined();
    expect(askProblem(one(slider({ max: 9 })))).toMatch(/reachable from min by whole steps/);
  });

  it("rejects duplicate ids, empty pages, and ids a revise would reuse", () => {
    expect(askProblem(one(single, single))).toMatch(/used twice/);
    expect(askProblem({ pages: [] })).toMatch(/at least one page/);
    expect(askProblem({ pages: [{ title: "x", questions: [] }] })).toMatch(/no questions/);
    expect(askProblem(one(single), ["q1"])).toMatch(/used twice/);
  });

  it("ask_revise marks the card as replacing the remaining pages of that call", () => {
    const r = reviseResult({ callId: "call-1", pages: [{ title: "New", questions: [{ id: "n1", ask: "x", kind: "free" }] }] }, ["q1"]);
    expect(CardSchema.parse((r as { card: unknown }).card)).toMatchObject({ revises: "call-1", paged: true });
  });
});
