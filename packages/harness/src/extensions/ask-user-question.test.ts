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
