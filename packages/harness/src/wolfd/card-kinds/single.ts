import type { AnyField, CardOption } from "@wolfpack/protocol";
import { EMPTY_RESPONSE, NO_ANSWER, optionEntry, type FieldKind } from "./types.js";

const optionsOf = (f: AnyField): CardOption[] => (Array.isArray(f.options) ? (f.options as CardOption[]) : []);

export const singleFieldKind: FieldKind = {
  kind: "single",
  validate(f, a) {
    if (typeof a.value !== "string") return `field "${f.id}": the answer must be a string`;
    if ("other" in a && a.other) {
      if (f.allowOther === false) return `field "${f.id}" does not accept a custom answer`;
      if (a.value.trim() === "") return `field "${f.id}": a custom answer cannot be empty`;
    } else if (!optionsOf(f).some((o) => o.value === a.value)) return `"${a.value}" is not an option of field "${f.id}"`;
    return undefined;
  },
  isEmpty: (_f, a) => typeof a.value === "string" && a.value.trim() === "",
  answerText(f, a) {
    if (typeof a.value !== "string") return NO_ANSWER;
    if (a.value.trim() === "") return EMPTY_RESPONSE;
    if ("other" in a && a.other === true) return `other: ${JSON.stringify(a.value)}`;
    return optionEntry(optionsOf(f), a.value, false);
  },
};
