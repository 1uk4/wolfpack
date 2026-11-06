import { afterEach, describe, expect, it } from "vitest";
import { CardSchema, registerCardKind, unregisterCardKind, type Card } from "@wolfpack/protocol";
import { z } from "zod";
import { fieldKind, registerFieldKind, unregisterFieldKind } from "./card-kinds/index.js";
import { answerText, validateAnswers } from "./cards.js";

afterEach(() => {
  unregisterCardKind("slider");
  unregisterFieldKind("slider");
});

const sliderCard = { tool: "brief", fields: [{ id: "n", kind: "slider", label: "How many?", lo: 1, hi: 10 }] };

describe("field-kind registry", () => {
  it("a dummy kind works end to end: schema → validate → answerText", () => {
    expect(CardSchema.safeParse(sliderCard).success).toBe(true); // unknown kind: loose, forward compatible
    registerCardKind({
      kind: "slider",
      fieldSchema: z.object({ id: z.string(), kind: z.literal("slider"), label: z.string(), lo: z.number(), hi: z.number(), optional: z.boolean().optional() }),
      answerSchema: z.object({ value: z.number() }),
    });
    registerFieldKind({
      kind: "slider",
      validate: (f, a) => (typeof a.value !== "number" || a.value < (f.lo as number) || a.value > (f.hi as number) ? "out of range" : undefined),
      isEmpty: () => false,
      answerText: (_f, a) => `${a.value as number} on the slider`,
    });
    // registered: a malformed field now fails its own schema
    expect(CardSchema.safeParse({ ...sliderCard, fields: [{ id: "n", kind: "slider", label: "x" }] }).success).toBe(false);
    const card = CardSchema.parse(sliderCard) as Card;
    expect(validateAnswers(card, { n: { value: 4 } as never })).toBeUndefined();
    expect(validateAnswers(card, { n: { value: 40 } as never })).toBe("out of range");
    expect(answerText([{ callId: "c1", card, answers: { n: { value: 4 } as never } }])).toContain("- How many?: 4 on the slider");
  });

  it("an unknown kind is handled like free text", () => {
    const card = CardSchema.parse(sliderCard) as Card;
    expect(fieldKind("slider").kind).toBe("free-text");
    expect(validateAnswers(card, { n: { value: "7" } })).toBeUndefined();
    expect(answerText([{ callId: "c1", card, answers: { n: { value: "7" } } }])).toContain("- How many?: 7");
  });

  it("a zero-question brief card is acknowledged", () => {
    const card = CardSchema.parse({ tool: "brief", fields: [], brief: { headline: "h" } }) as Card;
    expect(validateAnswers(card, {})).toBeUndefined();
    expect(answerText([{ callId: "c1", card, answers: {} }])).toContain("acknowledged");
  });
});
