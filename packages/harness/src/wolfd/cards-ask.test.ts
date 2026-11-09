import { describe, expect, it } from "vitest";
import { askRecord, askSupersedeDetail } from "@wolfpack/protocol";
import { CARD_ANSWER_KIND, CARD_DETAILS_KEY } from "../engine/index.js";
import { askCard, type AskQuestion } from "../extensions/ask.js";
import { supersededNotes } from "../superseded-note.js";
import { CardTracker, answerText } from "./cards.js";
import { messagesFromEntries } from "./messages.js";

const free = (id: string, ask = id): AskQuestion => ({ id, ask, kind: "free", context: `ctx ${id}` });
const choice: AskQuestion = { id: "pick", ask: "Pick", kind: "single", choices: [{ label: "A", value: "a", tradeoff: "t" }] };
const twoPages = () => askCard({ pages: [{ title: "P1", questions: [free("q1"), choice] }, { title: "P2", questions: [free("q2")] }] });

const toolEntry = (id: number, callId: string, card: unknown) =>
  ({ id, kind: "pi.tool_result", model: [{ role: "toolResult", toolCallId: callId, toolName: "ask", content: [], timestamp: 1, details: { [CARD_DETAILS_KEY]: card } }] }) as never;
const pageEntry = (id: number, callId: string, page: number, answers: object, final?: true) =>
  ({ id, kind: CARD_ANSWER_KIND, data: { cards: [{ callId, answers, page, ...(final ? { final } : {}) }] } }) as never;
const userEntry = (id: number) => ({ id, kind: "pi.user", model: [{ role: "user", content: "hi" }] }) as never;

describe("paged ask card in the tracker", () => {
  it("stays pending after a non-final page, moves to the next page, closes on the last", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages())]);
    expect(t.pending()[0]).toMatchObject({ pageIndex: 0 });
    expect([...t.apply(pageEntry(2, "c", 0, { q1: { value: "x" } }))]).toEqual([]);
    expect(t.pending()[0]).toMatchObject({ pageIndex: 1, pageAnswers: { q1: { value: "x" } } });
    expect([...t.apply(pageEntry(3, "c", 1, { q2: { value: "y" } }, true))]).toEqual([["c", "answered"]]);
    expect(t.pending()).toEqual([]);
  });

  it("rebuilds the same progress from the transcript after a restart", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages()), pageEntry(2, "c", 0, { q1: { value: "x" } })]);
    expect(t.pending()[0]).toMatchObject({ pageIndex: 1 });
  });

  it("delivers a page's answers with the hold-your-turn rule, and the go-ahead on the last page", () => {
    const card = twoPages();
    const first = answerText([{ callId: "c", card, answers: { q1: { value: "x" }, pick: { value: "a" } }, page: 0 }]);
    expect(first).toContain("page 1 of 2");
    expect(first).toContain("- q1: x");
    expect(first).toMatch(/HOLD YOUR TURN.*ask_revise/);
    expect(first).not.toContain("q2");
    const last = answerText([{ callId: "c", card, answers: { q2: { value: "y" } }, page: 1, final: true }]);
    expect(last).toContain("you may proceed");
  });

  it("ask_revise replaces only the pages not yet answered", () => {
    const t = new CardTracker("w/home");
    const revision = askCard({ pages: [{ title: "New", questions: [free("n1"), free("n2")] }] }, "c");
    t.reset([toolEntry(1, "c", twoPages()), pageEntry(2, "c", 0, { q1: { value: "x" } }), toolEntry(3, "rev", revision)]);
    const p = t.pending();
    expect(p.map((x) => x.callId)).toEqual(["c"]); // the revise is not a card of its own
    expect(p[0].card.steps).toEqual([{ title: "P1", fields: ["q1", "pick"] }, { title: "New", fields: ["n1", "n2"] }]);
    expect(p[0]).toMatchObject({ pageIndex: 1 });
  });

  it("a revise that reuses an answered question id changes nothing", () => {
    const t = new CardTracker("w/home");
    const bad = askCard({ pages: [{ title: "New", questions: [free("q1")] }] }, "c");
    t.reset([toolEntry(1, "c", twoPages()), pageEntry(2, "c", 0, { q1: { value: "x" } }), toolEntry(3, "rev", bad)]);
    expect(t.pending()[0].card.steps).toHaveLength(2);
    expect(t.pending()[0].card.steps![1].fields).toEqual(["q2"]);
  });

  it("a plain message supersedes the open set and the note carries answered / skipped / unanswered", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages()), pageEntry(2, "c", 0, { q1: { value: "x" } })]);
    const p = t.pending()[0];
    const detail = askSupersedeDetail(p.card, p.pageAnswers, p.pageIndex!);
    expect(detail).toBe("q1 => x; Pick => skipped; q2 => unanswered");
    expect(supersededNotes([{ tool: "ask", callId: "c", detail }])).toContain("state when replaced: q1 => x; Pick => skipped; q2 => unanswered");
    expect([...t.apply(userEntry(3))]).toEqual([["c", "superseded"]]);
    expect(t.pending()).toEqual([]);
  });

  it("binds typed text to a question of the current page without closing or superseding anything", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages())]);
    expect(t.bindText("c", "pick", "my own")).toBeUndefined();
    expect(t.pending()[0].draft).toEqual({ pick: { value: "my own", other: true } });
    expect(t.bindText("c", "q2", "later")).toMatch(/not on the current page/);
    const claim = t.claimPage("c", { q1: { value: "x" } })!;
    expect(claim.ready.answers).toEqual({ pick: { value: "my own", other: true }, q1: { value: "x" } });
    expect(t.get("c")).toBeUndefined(); // claimed while submitting
  });
});

describe("askRecord", () => {
  it("keeps each question with its context and answer, skipped or unanswered", () => {
    const card = twoPages();
    const rec = askRecord(card, { q1: { value: "x" } }, 1, "superseded");
    expect(rec.state).toBe("superseded");
    expect(rec.items.map((i) => [i.id, i.state, i.context])).toEqual([["q1", "answered", "ctx q1"], ["pick", "skipped", undefined], ["q2", "unanswered", "ctx q2"]]);
    expect(askRecord(card, { q1: { value: "x" }, q2: { value: "y" } }, 2).state).toBe("answered");
  });
});

describe("paged card progress under races and withdrawal", () => {
  const revision = (ids: string[]) => askCard({ pages: [{ title: "New", questions: ids.map((i) => free(i)) }] }, "c");

  it("a revise folded while a page is being submitted only replaces pages after the claimed one", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages())]);
    const claim = t.claimPage("c", { q1: { value: "x" } })!;
    expect(claim.ready.final).toBeUndefined();
    t.apply(toolEntry(2, "rev", revision(["n1"])));
    expect(t.raisedCards()[0].card.steps).toEqual([{ title: "P1", fields: ["q1", "pick"] }, { title: "New", fields: ["n1"] }]);
    t.pageDone("c", 0, claim.merged);
    expect(t.get("c")).toMatchObject({ pageIndex: 1 });
    expect(Object.keys(t.get("c")!.pageAnswers!)).toEqual(["q1"]);
  });

  it("progress never moves back: a stale page entry is ignored and keeps the draft", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages())]);
    const claim = t.claimPage("c", { q1: { value: "x" } })!;
    t.pageDone("c", 0, claim.merged);
    t.bindText("c", "q2", "typed");
    t.apply(pageEntry(2, "c", 0, { q1: { value: "x" } }));
    expect(t.get("c")).toMatchObject({ pageIndex: 1, draft: { q2: { value: "typed" } } });
  });

  it("a withdrawn final page answer that cannot be re-sent restores progress before that page and keeps what was typed as the draft", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages())]);
    const c0 = t.claimPage("c", { q1: { value: "x" } })!;
    t.pageDone("c", 0, c0.merged);
    const c1 = t.claimPage("c", { q2: { value: "y" } })!;
    expect(c1.ready.final).toBe(true);
    t.settle(["c"]);
    t.reraise([c1.ready]);
    expect(t.get("c")).toMatchObject({ pageIndex: 1, pageAnswers: { q1: { value: "x" } }, draft: { q2: { value: "y" } } });
  });

  it("a revise that no longer fits is reported to the agent with the next page answer", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages()), pageEntry(2, "c", 0, { q1: { value: "x" } })]);
    t.apply(toolEntry(3, "rev", revision(["q1"])));
    const claim = t.claimPage("c", { q2: { value: "y" } })!;
    expect(answerText([claim.ready])).toMatch(/earlier ask_revise was NOT applied/);
  });

  it("refuses a revise once the last page is claimed, and keeps the late rejection for the agent", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages()), pageEntry(2, "c", 0, { q1: { value: "x" } })]);
    t.claimPage("c", { q2: { value: "y" } });
    expect(t.reviseTarget("c")).toEqual({ problem: expect.stringContaining("the last page") });
    t.apply(toolEntry(3, "rev", revision(["n1"]))); // a revise already in flight folds late
    expect(t.takeLateNote("c")).toMatch(/last page/);
    expect(t.takeLateNote("c")).toBeUndefined();
  });

  it("a revise rejected after the final page is claimed rides in that final answer", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages()), pageEntry(2, "c", 0, { q1: { value: "x" } })]);
    const claim = t.claimPage("c", { q2: { value: "y" } })!;
    t.apply(toolEntry(3, "rev", revision(["n1"])));
    const text = answerText([t.foldLateNote(claim.ready)]);
    expect(text).toMatch(/earlier ask_revise was NOT applied: .*last page[\s\S]*questionnaire is complete/);
    expect(t.takeLateNote("c")).toBeUndefined();
  });

  it("is not held while the final page is in flight", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages()), pageEntry(2, "c", 0, { q1: { value: "x" } })]);
    expect(t.holdOf()).toBeDefined();
    t.claimPage("c", { q2: { value: "y" } });
    expect(t.holdOf()).toBeUndefined();
  });

  it("bindText refuses blank and over-long text itself", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages())]);
    expect(t.bindText("c", "q1", "   ")).toMatch(/blank/);
    expect(t.bindText("c", "q1", "x".repeat(4001))).toMatch(/over 4000/);
    expect(t.bindText("c", "q1", "x".repeat(4000))).toBeUndefined();
  });

  it("pageDone with a stale page does not move progress back", () => {
    const t = new CardTracker("w/home");
    const three = askCard({ pages: [{ title: "P1", questions: [free("q1")] }, { title: "P2", questions: [free("q2")] }, { title: "P3", questions: [free("q3")] }] });
    t.reset([toolEntry(1, "c", three), pageEntry(2, "c", 0, { q1: { value: "x" } }), pageEntry(3, "c", 1, { q2: { value: "y" } })]);
    t.pageDone("c", 0, { q1: { value: "x" } });
    expect(t.get("c")).toMatchObject({ pageIndex: 2 });
  });

  it("a withdrawn non-final page answer restores progress and keeps the typed text as draft", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages())]);
    const c0 = t.claimPage("c", { q1: { value: "x" } })!;
    t.pageDone("c", 0, c0.merged);
    t.reraise([c0.ready]);
    expect(t.get("c")).toMatchObject({ pageIndex: 0, draft: { q1: { value: "x" } } });
    expect(t.get("c")!.pageAnswers).toBeUndefined();
  });

  it("a duplicate or out-of-order page entry does not regress the projected pagesDone", () => {
    const assistant = (id: number, callId: string) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", timestamp: id, content: [{ type: "toolCall", id: callId, name: "ask", arguments: {} }] }] }) as never;
    const list = messagesFromEntries([assistant(1, "c"), toolEntry(2, "c", twoPages()), pageEntry(3, "c", 0, { q1: { value: "x" } }), pageEntry(4, "c", 1, { q2: { value: "y" } }), pageEntry(5, "c", 0, { q1: { value: "OLD" } })]);
    expect(list[0].tools![0]).toMatchObject({ pagesDone: 2, pageAnswers: { q1: { value: "x" }, q2: { value: "y" } } });
  });

  it("holds only a paged card with an answered page, and clears on supersede", () => {
    const t = new CardTracker("w/home");
    t.reset([toolEntry(1, "c", twoPages())]);
    expect(t.holdOf()).toBeUndefined();
    t.apply(pageEntry(2, "c", 0, { q1: { value: "x" } }));
    expect(t.holdOf()).toEqual({ callId: "c", page: 2, total: 2 });
    t.apply(userEntry(3));
    expect(t.holdOf()).toBeUndefined();
  });
});
