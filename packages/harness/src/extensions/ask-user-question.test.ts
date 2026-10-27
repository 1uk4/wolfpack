import { describe, expect, it } from "vitest";
import { CardSchema } from "@wolfpack/protocol";
import { askCard, askProblem, createAskUserQuestionExtension } from "./ask-user-question.js";

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
    expect(askProblem({ questions: qs, steps: [{ questions: ["src", "strat", "depth"] }] })).toBeUndefined();
  });
});
