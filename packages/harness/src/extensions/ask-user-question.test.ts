import { describe, expect, it } from "vitest";
import { CardSchema } from "@wolfpack/protocol";
import { askCard } from "./ask-user-question.js";

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
        { id: "domain", question: "Sure?", kind: "confirm", confirmLabel: "Yes!" },
      ],
    });
    expect(card.title).toBe("Plan");
    expect(card.fields.map((f) => [f.id, f.kind])).toEqual([["q1", "free-text"], ["domain", "single"], ["tags", "multi"], ["domain-4", "confirm"]]);
    expect(CardSchema.safeParse(card).success).toBe(true);
  });
});
