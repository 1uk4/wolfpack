import { describe, expect, it } from "vitest";
import { CardSchema, visibleFields, type Card } from "./schemas.js";

const OPTS = [{ label: "A", value: "a" }, { label: "B", value: "b" }];
const base = (extra: object = {}): Card =>
  ({
    tool: "t",
    fields: [
      { id: "k", kind: "single", label: "k", options: OPTS },
      { id: "d", kind: "free-text", label: "d", showIf: { field: "k", equals: "a" } },
      { id: "z", kind: "confirm", label: "z" },
    ],
    ...extra,
  }) as Card;

describe("card steps / showIf schema", () => {
  it("accepts steps covering every field once, and showIf on an earlier field", () => {
    expect(CardSchema.safeParse(base({ steps: [{ title: "One", fields: ["k", "d"] }, { fields: ["z"] }] })).success).toBe(true);
    expect(CardSchema.safeParse(base()).success).toBe(true); // both are optional (older cards parse unchanged)
  });

  it.each([
    ["a missing field", { steps: [{ fields: ["k", "d"] }] }],
    ["a repeated field", { steps: [{ fields: ["k", "d"] }, { fields: ["d", "z"] }] }],
    ["an unknown field", { steps: [{ fields: ["k", "d", "z", "nope"] }] }],
    ["an empty step", { steps: [{ fields: [] }, { fields: ["k", "d", "z"] }] }],
  ])("rejects steps with %s", (_n, extra) => {
    expect(CardSchema.safeParse(base(extra)).success).toBe(false);
  });

  it("showIf must name an earlier field and exactly one of equals / oneOf", () => {
    const withShow = (showIf: object): Card => ({ tool: "t", fields: [{ id: "k", kind: "single", label: "k", options: OPTS }, { id: "d", kind: "free-text", label: "d", showIf } as never] });
    expect(CardSchema.safeParse(withShow({ field: "k", equals: "a" })).success).toBe(true);
    expect(CardSchema.safeParse(withShow({ field: "k", oneOf: ["a", "b"] })).success).toBe(true);
    expect(CardSchema.safeParse(withShow({ field: "k" })).success).toBe(false);
    expect(CardSchema.safeParse(withShow({ field: "k", equals: "a", oneOf: ["a"] })).success).toBe(false);
    expect(CardSchema.safeParse(withShow({ field: "later", equals: "a" })).success).toBe(false);
    expect(CardSchema.safeParse(withShow({ field: "d", equals: "a" })).success).toBe(false); // itself
  });

  it("visibleFields: equals / oneOf / confirm, and a chain collapses with its root", () => {
    const c: Card = {
      tool: "t",
      fields: [
        { id: "k", kind: "single", label: "k", options: OPTS },
        { id: "m", kind: "confirm", label: "m", showIf: { field: "k", oneOf: ["a", "b"] } },
        { id: "n", kind: "free-text", label: "n", showIf: { field: "m", equals: true } },
      ],
    };
    const ids = (a: object) => visibleFields(c, a as never).map((f) => f.id);
    expect(ids({})).toEqual(["k"]);
    expect(ids({ k: { value: "a" } })).toEqual(["k", "m"]);
    expect(ids({ k: { value: "a" }, m: { value: true } })).toEqual(["k", "m", "n"]);
    expect(ids({ k: { value: "zzz" }, m: { value: true } })).toEqual(["k"]);
  });
});
