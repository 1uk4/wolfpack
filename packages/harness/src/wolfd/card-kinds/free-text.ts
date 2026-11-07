import { EMPTY_RESPONSE, NO_ANSWER, type FieldKind } from "./types.js";

export const freeTextFieldKind: FieldKind = {
  kind: "free-text",
  validate(f, a) {
    if (typeof a.value !== "string") return `field "${f.id}" is free text: the answer must be a string`;
    if ("other" in a && a.other) return `field "${f.id}" is free text: "other" does not apply`;
    if (!f.optional && a.value.trim() === "") return `field "${f.id}" is required: the answer cannot be blank`;
    return undefined;
  },
  isEmpty: (_f, a) => typeof a.value === "string" && a.value.trim() === "",
  answerText(_f, a) {
    if (typeof a.value !== "string") return NO_ANSWER;
    return a.value.trim() === "" ? EMPTY_RESPONSE : a.value;
  },
};
