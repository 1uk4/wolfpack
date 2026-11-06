import { NO_ANSWER, type FieldKind } from "./types.js";

export const confirmFieldKind: FieldKind = {
  kind: "confirm",
  validate: (f, a) => (typeof a.value !== "boolean" ? `field "${f.id}" is a confirm: the answer must be true or false` : undefined),
  // A confirm is skipped only when ABSENT: a present but malformed one is validated and rejected.
  isEmpty: () => false,
  answerText(f, a) {
    if (typeof a.value !== "boolean") return NO_ANSWER;
    const text = a.value ? `yes (${(f.confirmLabel as string | undefined) ?? "Yes"})` : `no (${(f.rejectLabel as string | undefined) ?? "No"})`;
    const note = "note" in a && typeof a.note === "string" ? a.note.trim() : undefined;
    return note ? `${text} — ${note}` : text;
  },
};
