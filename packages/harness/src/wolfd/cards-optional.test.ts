/** Optional card fields and showIf on the server: skipped answers are accepted and reported, hidden fields never block. */
import { describe, expect, it } from "vitest";
import { CardSchema, type Card, type CardAnswers } from "@wolfpack/protocol";
import { answerText, validateAnswers } from "./cards.js";

const opts = [{ label: "A", value: "a" }, { label: "B", value: "b" }];
const card = (steps = false): Card =>
  CardSchema.parse({
    tool: "ask_user_question",
    fields: [
      { id: "name", kind: "free-text", label: "Name?" },
      { id: "note", kind: "free-text", label: "Note?", optional: true },
      { id: "pick", kind: "single", label: "Pick?", options: opts, allowOther: false, optional: true },
      { id: "tags", kind: "multi", label: "Tags?", options: opts, min: 1, max: 1, optional: true },
      { id: "ok", kind: "confirm", label: "OK?", optional: true },
      { id: "mode", kind: "single", label: "Mode?", options: opts, allowOther: false },
      { id: "extra", kind: "single", label: "Extra?", options: opts, allowOther: false, showIf: { field: "mode", equals: "a" } },
    ],
    ...(steps ? { steps: [{ fields: ["name", "note", "pick"] }, { fields: ["tags", "ok", "mode", "extra"] }] } : {}),
  });
const base: CardAnswers = { name: { value: "x" }, mode: { value: "b" } };
const skipped: CardAnswers = { ...base, note: { value: "" }, pick: { value: "" }, tags: { value: [] } };

describe("optional fields (server)", () => {
  it("accepts skipped optional fields as empty or missing, and says so in the answer text", () => {
    for (const answers of [skipped, base]) {
      expect(validateAnswers(card(), answers)).toBeUndefined();
      const text = answerText([{ callId: "c", card: card(), answers }]);
      for (const l of ["Note?", "Pick?", "Tags?", "OK?"]) expect(text).toContain(`- ${l}: (skipped)`);
      expect(text).toContain("- Name?: x");
    }
  });

  it("still validates a non-empty optional answer, incl. multi min/max", () => {
    expect(validateAnswers(card(), { ...skipped, pick: { value: "zzz" } })).toMatch(/not an option/);
    expect(validateAnswers(card(), { ...skipped, tags: { value: ["a", "b"] } })).toMatch(/at most 1/);
    expect(validateAnswers(card(), { ...skipped, tags: { value: ["a"] }, ok: { value: true } })).toBeUndefined();
    expect(validateAnswers(card(), { ...skipped, ok: { value: "yes" as unknown as boolean } })).toMatch(/true or false/);
  });

  it("a required blank is still rejected", () => {
    expect(validateAnswers(card(), { ...skipped, name: undefined as never })).toMatch(/missing answer for field "name"/);
    expect(validateAnswers(card(), { ...skipped, mode: { value: "" } })).toMatch(/not an option/);
    const { mode: _m, ...noMode } = skipped;
    expect(validateAnswers(card(), noMode)).toMatch(/missing answer for field "mode"/);
  });

  it("a field hidden by showIf never blocks (stepped or not), and is not shown to the model", () => {
    for (const steps of [false, true]) {
      expect(validateAnswers(card(steps), skipped)).toBeUndefined();
      expect(answerText([{ callId: "c", card: card(steps), answers: skipped }])).not.toContain("Extra?");
      // revealed, it is required again
      expect(validateAnswers(card(steps), { ...skipped, mode: { value: "a" } })).toMatch(/missing answer for field "extra"/);
    }
  });
});
