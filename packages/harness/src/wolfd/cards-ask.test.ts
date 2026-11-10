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
const threePages = () => askCard({ pages: [{ title: "P1", questions: [free("q1")] }, { title: "P2", questions: [free("q2")] }, { title: "P3", questions: [free("q3")] }] });

const toolEntry = (id: number, callId: string, card: unknown) =>
  ({ id, kind: "pi.tool_result", model: [{ role: "toolResult", toolCallId: callId, toolName: "ask", content: [], timestamp: 1, details: { [CARD_DETAILS_KEY]: card } }] }) as never;
const answerEntry = (id: number, callId: string, answers: object) => ({ id, kind: CARD_ANSWER_KIND, data: { cards: [{ callId, answers }] } }) as never;
const userEntry = (id: number) => ({ id, kind: "pi.user", model: [{ role: "user", content: "hi" }] }) as never;

const open = (card = twoPages()) => {
  const t = new CardTracker("w/home");
  t.reset([toolEntry(1, "c", card)]);
  return t;
};
const revision = (ids: string[]) => askCard({ pages: [{ title: "New", questions: ids.map((i) => free(i)) }] }, "c");

describe("transcript record of a submitted ask", () => {
	it("the call carries every page's answers and the owner's note", () => {
		const assistant = { id: 1, kind: "pi.assistant", model: [{ role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "c", name: "ask", arguments: {} }] }] } as never;
		const entry = { id: 3, kind: CARD_ANSWER_KIND, data: { cards: [{ callId: "c", answers: { q1: { value: "x" }, q2: { value: "y" } }, note: { text: "mind the budget", attachments: ["a1"] } }] } } as never;
		const [m] = messagesFromEntries([assistant, toolEntry(2, "c", twoPages()), entry]);
		expect(m!.tools![0]).toMatchObject({ closed: "answered", answer: { q1: { value: "x" }, q2: { value: "y" } }, note: { text: "mind the budget", attachments: ["a1"] } });
	});
});

describe("paged ask card draft in the tracker", () => {
  it("Back returns the saved answers, and reached never goes down", () => {
    const t = open(threePages());
    expect(t.savePage("c", 0, { q1: { value: "x" } }, 1)).toBeUndefined();
    t.savePage("c", 1, { q2: { value: "y" } }, 2);
    t.savePage("c", 2, {}, 0); // Back to the start
    expect(t.get("c")).toMatchObject({ pageIndex: 0, reached: 2, pageAnswers: { q1: { value: "x" }, q2: { value: "y" } } });
    t.savePage("c", 0, { q1: { value: "x2" } }, 1); // forward again over a page already passed
    expect(t.get("c")).toMatchObject({ pageIndex: 1, reached: 2, pageAnswers: { q1: { value: "x2" } } });
  });

  it("stays pending through saves, and closes on the single answer entry", () => {
    const t = open();
    t.savePage("c", 0, { q1: { value: "x" } }, 1);
    expect(t.pending()).toHaveLength(1);
    expect([...t.apply(answerEntry(2, "c", { q1: { value: "x" }, q2: { value: "y" } }))]).toEqual([["c", "answered"]]);
    expect(t.pending()).toEqual([]);
  });

  it("claimSubmit merges every page, the bound drafts of other pages and the note into one answer", () => {
    const t = open();
    t.savePage("c", 0, { q1: { value: "x" } }, 1);
    t.bindText("c", "pick", "my own"); // bound while viewing page 2
    t.setNote("c", { text: "mind the budget" });
    const merged = t.mergedAnswers("c", { q2: { value: "y" } })!;
    const ready = t.claimSubmit("c", merged)!;
    expect(ready.answers).toEqual({ q1: { value: "x" }, pick: { value: "my own", other: true }, q2: { value: "y" } });
    expect(ready.note).toEqual({ text: "mind the budget" });
    expect(t.get("c")).toBeUndefined(); // claimed while submitting
  });

  it("a failed submit gives back the drafts and the note", () => {
    const t = open();
    t.savePage("c", 0, { q1: { value: "x" } }, 1);
    t.bindText("c", "q2", "typed");
    t.setNote("c", { text: "n" });
    const ready = t.claimSubmit("c", t.mergedAnswers("c")!)!;
    t.settle(["c"]);
    t.reraise([ready]);
    expect(t.get("c")).toMatchObject({ pageIndex: 1, reached: 1, pageAnswers: { q1: { value: "x" } }, draft: { q2: { value: "typed" } }, note: { text: "n" } });
  });

  it("an empty note clears it", () => {
    const t = open();
    t.setNote("c", { text: "n" });
    t.setNote("c", {});
    expect(t.get("c")!.note).toBeUndefined();
  });

  it("binds typed text to a question on any page without closing or superseding anything", () => {
    const t = open();
    expect(t.bindText("c", "pick", "my own")).toBeUndefined();
    expect(t.bindText("c", "q2", "later page")).toBeUndefined();
    expect(t.get("c")!.draft).toEqual({ pick: { value: "my own", other: true }, q2: { value: "later page" } });
    expect(t.bindText("c", "nope", "x")).toMatch(/not on this questionnaire/);
    expect(t.pending()).toHaveLength(1);
  });

  it("bindText refuses blank and over-long text itself", () => {
    const t = open();
    expect(t.bindText("c", "q1", "   ")).toMatch(/blank/);
    expect(t.bindText("c", "q1", "x".repeat(4001))).toMatch(/over 4000/);
    expect(t.bindText("c", "q1", "x".repeat(4000))).toBeUndefined();
  });

  it("the note's images count against the same cap as the images bound to questions", () => {
    const t = open();
    t.bindText("c", "q1", "", ["a", "b", "c", "d", "e"]);
    expect(t.setNote("c", { attachments: ["f", "g", "h", "i"] })).toMatch(/at most 8 images/);
    expect(t.setNote("c", { attachments: ["f", "g", "h"] })).toBeUndefined();
    expect(t.bindText("c", "q2", "", ["z"])).toMatch(/at most 8 images/);
  });
});

describe("ask_revise against the draft", () => {
  it("replaces only the pages the owner has not moved past, and drops saved answers of questions that are gone", () => {
    const t = open();
    t.savePage("c", 0, { q1: { value: "x" } }, 1);
    t.savePage("c", 1, { q2: { value: "y" } }, 1); // saved but not moved past
    t.apply(toolEntry(3, "rev", revision(["n1", "n2"])));
    const p = t.pending();
    expect(p.map((x) => x.callId)).toEqual(["c"]); // the revise is not a card of its own
    expect(p[0].card.steps).toEqual([{ title: "P1", fields: ["q1", "pick"] }, { title: "New", fields: ["n1", "n2"] }]);
    expect(p[0].pageAnswers).toEqual({ q1: { value: "x" } });
  });

  it("keeps the pages already reached fixed: a revise that reuses their ids changes nothing", () => {
    const t = open();
    t.savePage("c", 0, { q1: { value: "x" } }, 1);
    t.apply(toolEntry(3, "rev", revision(["q1"])));
    expect(t.pending()[0].card.steps![1].fields).toEqual(["q2"]);
  });

  it("is refused once every page is reached or a submit is claimed", () => {
    const t = open();
    t.savePage("c", 0, {}, 1);
    t.savePage("c", 1, {}, 1); // forward over the last page: not a move past it
    expect(t.reviseTarget("c")).toMatchObject({ keep: 1 });
    const t2 = open(threePages());
    t2.savePage("c", 0, {}, 1);
    t2.savePage("c", 1, {}, 2);
    expect(t2.reviseTarget("c")).toMatchObject({ keep: 2 });
    t2.claimSubmit("c", {});
    expect(t2.reviseTarget("c")).toEqual({ problem: expect.stringContaining("being submitted") });
  });

  it("a revise that no longer fits is reported to the agent with the submit", () => {
    const t = open();
    t.savePage("c", 0, { q1: { value: "x" } }, 1);
    t.apply(toolEntry(3, "rev", revision(["q1"])));
    const ready = t.claimSubmit("c", { q1: { value: "x" }, q2: { value: "y" } })!;
    expect(answerText([ready])).toMatch(/earlier ask_revise was NOT applied/);
  });
});

describe("the result text and the supersede note", () => {
  it("a paged card's text omits a question its showIf hides", () => {
    const gated = {
      tool: "ask",
      paged: true,
      fields: [
        { id: "mode", kind: "single", label: "Mode?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], allowOther: false },
        { id: "why", kind: "free-text", label: "Why?", showIf: { field: "mode", equals: "yes" } },
      ],
      steps: [{ title: "P1", fields: ["mode", "why"] }],
    } as never;
    const text = answerText([{ callId: "c", card: gated, answers: { mode: { value: "no" } } }]);
    expect(text).toContain("- Q1 Mode?: No (no)");
    expect(text).not.toContain("Why?");
  });

  it("lists every page with its numbered questions, then the note and the go-ahead", () => {
    const text = answerText([{ callId: "c", card: twoPages(), answers: { q1: { value: "x" }, pick: { value: "a" }, q2: { value: "y" } }, note: { text: "mind it", attachments: ["i1", "i2"] } }]);
    expect(text).toContain('Page 1 of 2 ("P1"):');
    expect(text).toContain("- Q1 q1: x");
    expect(text).toContain('Page 2 of 2 ("P2"):');
    expect(text).toContain("- Q3 q2: y");
    expect(text).toContain("Note from the user: mind it [2 images attached below]");
    expect(text.trim().endsWith("The questionnaire is complete: you may proceed.")).toBe(true);
    expect(text).not.toContain("HOLD YOUR TURN");
  });

  it("a plain message supersedes the open set; the note shows partials across ALL pages, answered and unanswered", () => {
    const t = open();
    t.savePage("c", 0, { q1: { value: "x" } }, 1);
    t.bindText("c", "q2", "typed");
    const p = t.pending()[0];
    const detail = askSupersedeDetail(p.card, p.pageAnswers, p.reached!, p.draft);
    expect(detail).toBe("Page 1 of 2 (P1): q1 => x; Pick => skipped | Page 2 of 2 (P2): q2 => typed (typed, not submitted)");
    expect(supersededNotes([{ tool: "ask", callId: "c", detail }])).toContain("state when replaced: Page 1 of 2");
    expect([...t.apply(userEntry(3))]).toEqual([["c", "superseded"]]);
    expect(t.pending()).toEqual([]);
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
