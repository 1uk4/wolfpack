import { EMPTY_RESPONSE, NO_ANSWER, type FieldKind, IMAGE_ONLY_TEXT, isImageOnly } from "./types.js";

export const freeTextFieldKind: FieldKind = {
  kind: "free-text",
  validate(f, a) {
    if (typeof a.value !== "string") return `field "${f.id}" is free text: the answer must be a string`;
    if ("other" in a && a.other) return `field "${f.id}" is free text: "other" does not apply`;
    // Images alone count as one Other entry, which satisfies `required`.
    if (!f.optional && a.value.trim() === "" && !isImageOnly(a)) return `field "${f.id}" is required: the answer cannot be blank`;
    return undefined;
  },
  isEmpty: (_f, a) => !isImageOnly(a) && typeof a.value === "string" && a.value.trim() === "",
  answerText(_f, a) {
    if (isImageOnly(a)) return IMAGE_ONLY_TEXT;
    if (typeof a.value !== "string") return NO_ANSWER;
    return a.value.trim() === "" ? EMPTY_RESPONSE : a.value;
  },
};
