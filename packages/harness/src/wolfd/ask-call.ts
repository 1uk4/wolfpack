import { fauxToolCall } from "./scripted-model.js";

/** The retired ask_user_question's argument shape, kept so card tests script a `brief` call in a few words. */
export interface AskArgs {
  question: string;
  details?: string;
  options?: { label: string; value?: string }[];
  multiSelect?: boolean;
  kind?: "confirm";
  confirmLabel?: string;
  rejectLabel?: string;
}

/** A scripted `brief` call holding one question. The field id is "answer" ("confirm" for yes/no). */
export function askCall(a: AskArgs) {
  return fauxToolCall("brief", {
    headline: "Question",
    questions: [
      {
        id: a.kind === "confirm" ? "confirm" : "answer",
        ask: a.question,
        ...(a.details ? { note: a.details } : {}),
        ...(a.kind === "confirm" ? { kind: "confirm" } : a.multiSelect ? { kind: "multi" } : {}),
        ...(a.options ? { choices: a.options } : {}),
        ...(a.confirmLabel ? { yesLabel: a.confirmLabel } : {}),
        ...(a.rejectLabel ? { noLabel: a.rejectLabel } : {}),
      },
    ],
  });
}
