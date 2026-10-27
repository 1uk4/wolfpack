import { describe, expect, it } from "vitest";
import { CardSchema } from "@wolfpack/protocol";
import { askCard, askProblem, createAskUserQuestionExtension } from "./ask-user-question.js";

describe("askCard optional", () => {
  it("maps optional onto the field (batch and single question) and the card stays valid", () => {
    const card = askCard({
      questions: [
        { question: "A?", optional: true },
        { question: "B?" },
        { id: "c", question: "C", options: [{ label: "x" }], multiSelect: true, optional: true },
        { id: "d", question: "D?", kind: "confirm", optional: true },
      ],
    });
    expect(card.fields.map((f) => f.optional)).toEqual([true, undefined, true, true]);
    expect(CardSchema.safeParse(card).success).toBe(true);
    expect(askCard({ question: "Q?", optional: true }).fields[0]).toMatchObject({ optional: true });
    expect(askCard({ question: "Q?", kind: "confirm", optional: true }).fields[0]).toMatchObject({ kind: "confirm", optional: true });
    expect(askCard({ question: "Q?" }).fields[0]).not.toHaveProperty("optional");
  });

  it("optional parses on every field kind in the protocol", () => {
    const card = {
      tool: "t",
      fields: [
        { id: "a", kind: "free-text", label: "a", optional: true },
        { id: "b", kind: "single", label: "b", options: [{ label: "x", value: "x" }], optional: true },
        { id: "c", kind: "multi", label: "c", options: [{ label: "x", value: "x" }], optional: true },
        { id: "d", kind: "confirm", label: "d", optional: true },
      ],
    };
    expect(CardSchema.parse(card).fields.every((f) => f.optional === true)).toBe(true);
    expect(CardSchema.safeParse({ ...card, fields: [{ id: "a", kind: "free-text", label: "a", optional: "yes" }] }).success).toBe(false);
  });
});

describe("askCard", () => {
  it("a single question keeps its legacy field ids", () => {
    expect(askCard({ question: "Q?" }).fields[0]).toMatchObject({ id: "answer", kind: "free-text" });
    expect(askCard({ question: "Q?", kind: "confirm" }).fields[0]).toMatchObject({ id: "confirm", kind: "confirm" });
  });

  it("`questions` batches one field per question (free-text, single, multi, confirm) into a valid card", () => {
    const card = askCard({
      title: "Plan",
      questions: [
        { question: "Source?" },
        { id: "domain", question: "Domain", options: [{ label: "a" }, { label: "b", value: "B" }] },
        { id: "tags", question: "Tags", options: [{ label: "x" }], multiSelect: true },
        { question: "Sure?", kind: "confirm", confirmLabel: "Yes!" },
      ],
    });
    expect(card.title).toBe("Plan");
    expect(card.fields.map((f) => [f.id, f.kind])).toEqual([["q1", "free-text"], ["domain", "single"], ["tags", "multi"], ["q4", "confirm"]]);
    expect(CardSchema.safeParse(card).success).toBe(true);
  });

  it("batch validation: both forms, blank entries, duplicate ids are errors", async () => {
    expect(askProblem({ question: "Q", questions: [{ question: "A" }] })).toMatch(/not both/);
    expect(askProblem({ questions: [{ question: "A" }, { question: "  " }] })).toMatch(/questions\[1\] has no question/);
    expect(askProblem({ questions: [{ id: "x", question: "A" }, { id: "x", question: "B" }] })).toMatch(/duplicate question id "x"/);
    expect(askProblem({ questions: [{ question: "A" }, { id: "q1", question: "B" }] })).toMatch(/duplicate question id "q1"/); // collides with the auto id
    expect(askProblem({})).toMatch(/needs `question`/);
    expect(askProblem({ questions: [{ id: "a", question: "A" }, { question: "B" }] })).toBeUndefined();
    const tool = createAskUserQuestionExtension().tools![0];
    const r = (await tool.execute({ question: "Q", questions: [{ question: "A" }] }, {} as never)) as { isError?: boolean; card?: unknown };
    expect(r.isError).toBe(true);
    expect(r.card).toBeUndefined();
  });
});

describe("steps / showIf", () => {
  const qs = [
    { id: "src", question: "Source?" },
    { id: "strat", question: "Strategy?", options: [{ label: "By folder", value: "by-folder" }, { label: "By pattern", value: "by-pattern" }] },
    { id: "depth", question: "Depth?", options: [{ label: "1" }], showIf: { field: "strat", equals: "by-folder" } },
  ];

  it("builds a valid stepped card with a conditional field", () => {
    const card = askCard({ questions: qs, steps: [{ title: "A", questions: ["src"] }, { questions: ["strat", "depth"] }] });
    expect(CardSchema.safeParse(card).success).toBe(true);
    expect(card.steps).toEqual([{ title: "A", fields: ["src"] }, { fields: ["strat", "depth"] }]);
    expect(card.fields[2].showIf).toEqual({ field: "strat", equals: "by-folder" });
  });

  it("rejects bad showIf and step groupings with model-facing errors", () => {
    expect(askProblem({ questions: [{ id: "a", question: "A", showIf: { field: "b", equals: "x" } }, { id: "b", question: "B" }] })).toMatch(/earlier question/);
    expect(askProblem({ questions: [{ id: "a", question: "A" }, { id: "b", question: "B", showIf: { field: "a" } }] })).toMatch(/exactly one of/);
    expect(askProblem({ questions: qs, steps: [{ questions: ["src", "strat"] }] })).toMatch(/exactly once/);
    expect(askProblem({ questions: qs, steps: [{ questions: ["src", "strat", "depth", "nope"] }] })).toMatch(/unknown question id "nope"/);
    expect(askProblem({ questions: qs, steps: [{ questions: ["strat", "src", "depth"] }] })).toMatch(/in their order/);
    expect(askProblem({ questions: qs, steps: [{ questions: ["src", "strat", "depth"] }] })).toBeUndefined();
    // showIf against the controller's kind
    const opts = [{ label: "x" }];
    expect(askProblem({ questions: [{ id: "c", question: "C", options: opts }, { id: "d", question: "D", showIf: { field: "c", equals: "nope" } }] })).toMatch(/not an option/);
    expect(askProblem({ questions: [{ id: "c", question: "C" }, { id: "d", question: "D", showIf: { field: "c", equals: "x" } }] })).toMatch(/cannot control/);
    expect(askProblem({ questions: [{ id: "c", question: "C", kind: "confirm" }, { id: "d", question: "D", showIf: { field: "c", equals: "x" } }] })).toMatch(/boolean/);
    expect(askProblem({ questions: [{ id: "c", question: "C", kind: "confirm" }, { id: "d", question: "D", showIf: { field: "c", equals: true } }] })).toBeUndefined();
    expect(askProblem({ questions: [{ id: "c", question: "C", options: opts, multiSelect: true }, { id: "d", question: "D", showIf: { field: "c", equals: "x" } }] })).toMatch(/cannot control/);
  });
});

describe("minSelect / maxSelect", () => {
  const options = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }];
  it("map onto the multi field's min / max (single question and batch), and the card stays valid", () => {
    const single = { question: "Q", options, multiSelect: true, minSelect: 1, maxSelect: 3 };
    expect(askProblem(single)).toBeUndefined();
    const card = askCard(single);
    expect(card.fields[0]).toMatchObject({ kind: "multi", min: 1, max: 3 });
    expect(CardSchema.safeParse(card).success).toBe(true);
    const batch = { questions: [{ id: "m", question: "Q", options, multiSelect: true, maxSelect: 2 }] };
    expect(askProblem(batch)).toBeUndefined();
    const field = askCard(batch).fields[0];
    expect(field).toMatchObject({ kind: "multi", max: 2 });
    expect("min" in field).toBe(false);
  });
  it("readable errors: max < 1, min > max, negative or fractional, and not on a non-multi question", () => {
    expect(askProblem({ question: "Q", options, multiSelect: true, maxSelect: 0 })).toMatch(/maxSelect must be a whole number, 1 or more/);
    expect(askProblem({ question: "Q", options, multiSelect: true, minSelect: -1 })).toMatch(/minSelect must be a whole number, 0 or more/);
    expect(askProblem({ question: "Q", options, multiSelect: true, maxSelect: 1.5 })).toMatch(/maxSelect must be a whole number/);
    expect(askProblem({ question: "Q", options, multiSelect: true, minSelect: 3, maxSelect: 2 })).toMatch(/minSelect \(3\) cannot exceed maxSelect \(2\)/);
    expect(askProblem({ question: "Q", options, maxSelect: 2 })).toMatch(/only apply to a multiSelect question with options/);
    expect(askProblem({ question: "Q", multiSelect: true, maxSelect: 2 })).toMatch(/only apply to a multiSelect question with options/);
    expect(askProblem({ questions: [{ question: "A" }, { question: "B", options, multiSelect: true, minSelect: 4, maxSelect: 2 }] })).toMatch(/questions\[1\]\.minSelect \(4\)/);
  });
  it("a min above the option count is rejected with a readable error", () => {
    expect(askProblem({ question: "Q", options: options.slice(0, 2), multiSelect: true, minSelect: 3 })).toMatch(/minSelect \(3\) cannot exceed the number of options \(2\)/);
    expect(askProblem({ question: "Q", options: options.slice(0, 2), multiSelect: true, minSelect: 2 })).toBeUndefined();
  });
});
