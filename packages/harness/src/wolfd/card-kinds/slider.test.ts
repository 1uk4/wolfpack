import { describe, expect, it } from "vitest";
import { validateAnswers } from "../cards.js";
import { askCard } from "../../extensions/ask.js";

const check = (min: number, max: number, step: number, value: unknown) => {
  const card = askCard({ pages: [{ title: "P", questions: [{ id: "s", ask: "S", kind: "slider", min, max, step }] }] });
  return validateAnswers(card, { s: { value } as never });
};

describe("slider answer validation at submit", () => {
  it("accepts values on the scale, including 0.1 steps and negative ranges", () => {
    expect(check(0, 10, 2, 4)).toBeUndefined();
    expect(check(0, 1, 0.1, 0.3)).toBeUndefined(); // 0.3 is not exactly 3*0.1 in floats
    expect(check(-5, 5, 5, -5)).toBeUndefined();
  });
  it("rejects out of bounds, off step, NaN and non-numbers", () => {
    expect(check(0, 10, 2, 12)).toMatch(/outside 0\.\.10/);
    expect(check(0, 10, 2, -2)).toMatch(/outside/);
    expect(check(0, 10, 2, 3)).toMatch(/not on a step/);
    expect(check(-5, 5, 5, -3)).toMatch(/not on a step/);
    expect(check(0, 10, 2, Number.NaN)).toMatch(/must be a number/);
    expect(check(0, 10, 2, "4")).toMatch(/must be a number/);
  });
  it("an untouched slider is skipped, because its answer is omitted", () => {
    const card = askCard({ pages: [{ title: "P", questions: [{ id: "s", ask: "S", kind: "slider", min: 0, max: 10, step: 1, default: 5 }] }] });
    expect(validateAnswers(card, {})).toBeUndefined();
  });
});
