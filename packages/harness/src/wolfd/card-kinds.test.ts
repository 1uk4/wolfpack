import { afterEach, describe, expect, it } from "vitest";
import { CardAnswersSchema, CardSchema, registerCardKind, unregisterCardKind, type Card } from "@wolfpack/protocol";
import { z } from "zod";
import { fieldKind, registerFieldKind, unregisterFieldKind } from "./card-kinds/index.js";
import { answerText, validateAnswers } from "./cards.js";

afterEach(() => {
  unregisterCardKind("gauge");
  unregisterFieldKind("gauge");
});

const gaugeCard = { tool: "brief", fields: [{ id: "n", kind: "gauge", label: "How many?", lo: 1, hi: 10 }] };

describe("field-kind registry", () => {
  it("a dummy kind works end to end: schema → validate → answerText", () => {
    expect(CardSchema.safeParse(gaugeCard).success).toBe(true); // unknown kind: loose, forward compatible
    registerCardKind({
      kind: "gauge",
      fieldSchema: z.object({ id: z.string(), kind: z.literal("gauge"), label: z.string(), lo: z.number(), hi: z.number(), optional: z.boolean().optional() }),
      answerSchema: z.object({ value: z.string(), unit: z.string() }),
    });
    registerFieldKind({
      kind: "gauge",
      validate: (f, a) => (Number(a.value) < (f.lo as number) || Number(a.value) > (f.hi as number) ? "out of range" : undefined),
      isEmpty: () => false,
      answerText: (_f, a) => `${a.value as string} ${(a as unknown as { unit: string }).unit} on the gauge`,
    });
    // registered: a malformed field now fails its own schema
    expect(CardSchema.safeParse({ ...gaugeCard, fields: [{ id: "n", kind: "gauge", label: "x" }] }).success).toBe(false);
    const card = CardSchema.parse(gaugeCard) as Card;
    // a string `value` plus an extra prop: free-text would strip `unit`, the gauge schema keeps it
    const parsed = CardAnswersSchema.parse({ n: { value: "4", unit: "cm" } });
    expect(parsed.n).toEqual({ value: "4", unit: "cm" });
    expect(validateAnswers(card, parsed)).toBeUndefined();
    expect(validateAnswers(card, { n: { value: "40", unit: "cm" } as never })).toBe("out of range");
    expect(answerText([{ callId: "c1", card, answers: parsed }])).toContain("- How many?: 4 cm on the gauge");
  });

  it("an unknown kind is handled like free text", () => {
    const card = CardSchema.parse(gaugeCard) as Card;
    expect(fieldKind("gauge").kind).toBe("free-text");
    expect(validateAnswers(card, { n: { value: "7" } })).toBeUndefined();
    expect(answerText([{ callId: "c1", card, answers: { n: { value: "7" } } }])).toContain("- How many?: 7");
  });

  it("a zero-question brief card is acknowledged", () => {
    const card = CardSchema.parse({ tool: "brief", fields: [], brief: { headline: "h" } }) as Card;
    expect(validateAnswers(card, {})).toBeUndefined();
    expect(answerText([{ callId: "c1", card, answers: {} }])).toContain("acknowledged");
  });
});
