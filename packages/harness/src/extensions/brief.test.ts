import { describe, expect, it } from "vitest";
import { CardSchema } from "@wolfpack/protocol";
import { askAsBrief } from "./ask-user-question.js";
import { briefCard, briefProblem, briefResult, createBriefExtension } from "./brief.js";

describe("brief tool", () => {
  it("raises a valid card with the header and ends the turn via the card channel", async () => {
    const ext = createBriefExtension();
    const tool = ext.tools![0];
    expect(tool.name).toBe("brief");
    expect(tool.raisesCard).toBe(true);
    const r = (await tool.execute({ headline: "Ship it?", context: ["a", "b"], more: "see above", questions: [{ ask: "Go?", kind: "confirm" }] } as never, {} as never)) as { card: unknown; isError?: boolean };
    expect(r.isError).toBeUndefined();
    const card = CardSchema.parse(r.card);
    expect(card.tool).toBe("brief");
    expect(card.brief).toEqual({ headline: "Ship it?", context: ["a", "b"], more: "see above" });
    expect(card.fields).toHaveLength(1);
  });

  it("allows zero questions", () => {
    const r = briefResult({ headline: "Done: tests pass" });
    expect("card" in r && CardSchema.parse(r.card).fields).toEqual([]);
  });

  it("rejects over-limit calls with a message that says how to fix it", () => {
    expect(briefProblem({ headline: "x".repeat(81) })).toMatch(/limit is 80.*thread message/);
    expect(briefProblem({ headline: "h", context: ["1", "2", "3", "4", "5", "6"] })).toMatch(/limit is 5.*thread message/);
    const q = { ask: "q" };
    expect(briefProblem({ headline: "h", questions: [q, q, q, q].map((x, i) => ({ ...x, id: `q${i}` })) })).toMatch(/limit is 3/);
    expect(briefProblem({ headline: "  " })).toMatch(/needs a `headline`/);
    expect(briefResult({ headline: "x".repeat(81) })).toMatchObject({ isError: true });
  });

  it("does not reject a long bullet (soft limit)", () => {
    expect(briefProblem({ headline: "h", context: ["y".repeat(400)] })).toBeUndefined();
  });

  it("builds every kind and showIf, steps", () => {
    const card = briefCard({
      headline: "h",
      questions: [
        { id: "a", ask: "pick", choices: [{ label: "One" }, { label: "Two", value: "2" }] },
        { id: "b", ask: "many", kind: "multi", choices: [{ label: "X" }], min: 1 },
        { id: "c", ask: "sure?", kind: "confirm", showIf: { field: "a", equals: "One" } },
      ],
    });
    expect(CardSchema.safeParse(card).success).toBe(true);
    expect(card.fields.map((f) => f.kind)).toEqual(["single", "multi", "confirm"]);
    expect(briefProblem({ headline: "h", questions: [{ id: "a", ask: "x" }, { id: "b", ask: "y", showIf: { field: "a", equals: "v" } }] })).toMatch(/cannot control/);
  });

  it("rejects a single/multi question without choices and a confirm/free one given choices", () => {
    expect(briefProblem({ headline: "h", questions: [{ ask: "q", kind: "single" }] })).toMatch(/kind "single" but has no choices/);
    expect(briefProblem({ headline: "h", questions: [{ ask: "q", kind: "multi", choices: [{ label: " " }] }] })).toMatch(/no choices/);
    expect(briefProblem({ headline: "h", questions: [{ ask: "q", kind: "confirm", choices: [{ label: "A" }] }] })).toMatch(/takes no `choices`/);
    expect(briefProblem({ headline: "h", questions: [{ ask: "q", kind: "free", choices: [{ label: "A" }] }] })).toMatch(/takes no `choices`/);
  });

  it("ask_user_question maps onto brief: neutral headline (or title), question stays the field label, details under it, questions through", () => {
    const single = askAsBrief({ question: "Which?", details: "because", options: [{ label: "A" }] });
    expect(single).toMatchObject({ headline: "A question for you", questions: [{ id: "answer", kind: "single", ask: "Which?", note: "because" }] });
    // the question is shown once (field label), and the answer text keeps it
    expect(briefCard(single!).fields[0].label).toBe("Which?");
    expect(briefCard(single!).fields[0].description).toBe("because");
    // a title takes the headline
    expect(askAsBrief({ title: "Deploy", question: "Which env?", options: [{ label: "A" }] })).toMatchObject({ headline: "Deploy", questions: [{ ask: "Which env?" }] });
    // ids that sanitizing would rewrite: keep the legacy card instead of changing answer keys
    expect(askAsBrief({ questions: [{ id: "my id", question: "q" }] })).toBeUndefined();
    expect(askAsBrief({ questions: [{ id: "a", question: "q" }, { id: "b", question: "r", showIf: { field: "a b", equals: "x" } }] })).toBeUndefined();
    const batch = askAsBrief({ title: "T", questions: [{ question: "q1", kind: "confirm" }, { question: "q2", options: [{ label: "A" }], multiSelect: true }] });
    expect(batch?.headline).toBe("T");
    expect(batch?.questions?.map((q) => q.kind)).toEqual(["confirm", "multi"]);
    // does not fit brief's limits (4 questions): the alias keeps its legacy card
    expect(askAsBrief({ questions: ["a", "b", "c", "d"].map((question) => ({ question })) })).toBeUndefined();
  });
});
