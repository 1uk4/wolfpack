/**
 * ask_user_question for durable wolves: raises an interaction card instead of blocking on a TUI prompt.
 *
 * The tool returns a card + terminate (see engine/cards.ts): the turn ends complete, the thread is marked needs-you,
 * and the operator's answer starts the next turn. Free text (no options), single choice (options + "Other"),
 * multi-select (`multiSelect`) and yes/no (`kind: "confirm"`).
 */
import type { Card, CardOption } from "@wolfpack/protocol";
import { confirmCard } from "../engine/cards.js";
import { defineExtension, defineTool, Type, type Extension } from "../extension-api.js";

const OptionSchema = Type.Object({
  label: Type.String({ description: 'Display label. If you recommend an option, place it first and append "(Recommended)".' }),
  value: Type.Optional(Type.String({ description: "Machine-readable value returned for the option. Defaults to the label." })),
  description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const QuestionSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Short identifier for the answer (letters, digits, dashes). Defaults to q1, q2, ..." })),
  question: Type.String({ description: "The question." }),
  details: Type.Optional(Type.String({ description: "Optional extra context shown under the question." })),
  options: Type.Optional(Type.Array(OptionSchema, { description: "Multiple-choice options; omit for free-form text." })),
  multiSelect: Type.Optional(Type.Boolean({ description: "Let the user pick several options (requires options)." })),
  kind: Type.Optional(Type.Literal("confirm", { description: 'Set to "confirm" for a yes/no question (options are ignored).' })),
  confirmLabel: Type.Optional(Type.String({ description: 'Confirm button label (kind "confirm"). Default "Yes".' })),
  rejectLabel: Type.Optional(Type.String({ description: 'Reject button label (kind "confirm"). Default "No".' })),
});

const Params = Type.Object({
  question: Type.Optional(Type.String({ description: "The question to ask the user. Ask one question per call, unless you batch related ones with `questions`." })),
  questions: Type.Optional(
    Type.Array(QuestionSchema, {
      description: "Batch several related questions into ONE card (the user answers them all at once). Use instead of `question`; each entry takes the same fields as a single question.",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Optional card title (useful with `questions`)." })),
  details: Type.Optional(Type.String({ description: "Optional extra context shown under the question." })),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description: "Optional multiple-choice options. Omit or pass an empty array for free-form text. The user can always type a custom answer too.",
    }),
  ),
  multiSelect: Type.Optional(Type.Boolean({ description: "Let the user pick several options (requires options)." })),
  kind: Type.Optional(Type.Literal("confirm", { description: 'Set to "confirm" for a yes/no question (options are ignored).' })),
  confirmLabel: Type.Optional(Type.String({ description: 'Confirm button label (kind "confirm"). Default "Yes".' })),
  rejectLabel: Type.Optional(Type.String({ description: 'Reject button label (kind "confirm"). Default "No".' })),
});

interface AskQuestion {
  id?: string;
  question: string;
  details?: string;
  options?: { label: string; value?: string; description?: string }[];
  multiSelect?: boolean;
  kind?: "confirm";
  confirmLabel?: string;
  rejectLabel?: string;
}

interface AskArgs {
  question?: string;
  questions?: AskQuestion[];
  title?: string;
  details?: string;
  options?: { label: string; value?: string; description?: string }[];
  multiSelect?: boolean;
  kind?: "confirm";
  confirmLabel?: string;
  rejectLabel?: string;
}

/** One card field for a question; `id` keys the answer. */
function questionField(q: AskQuestion, id: string): Card["fields"][number] {
  const options: CardOption[] = (q.options ?? [])
    .map((o) => ({ label: o.label.trim(), value: o.value?.trim() || o.label.trim(), ...(o.description?.trim() ? { description: o.description.trim() } : {}) }))
    .filter((o) => o.label.length > 0);
  const description = q.details?.trim() || undefined;
  const base = { id, label: q.question, ...(description ? { description } : {}) };
  if (q.kind === "confirm") {
    return {
      ...base,
      kind: "confirm",
      ...(q.confirmLabel?.trim() ? { confirmLabel: q.confirmLabel.trim() } : {}),
      ...(q.rejectLabel?.trim() ? { rejectLabel: q.rejectLabel.trim() } : {}),
    };
  }
  if (options.length === 0) return { ...base, kind: "free-text" };
  return q.multiSelect ? { ...base, kind: "multi", options, allowOther: true } : { ...base, kind: "single", options };
}

/** The card for one ask_user_question call: a single question (legacy field ids), or a batch with one field per question. */
export function askCard(args: AskArgs): Card {
  const batch = args.questions?.filter((q) => q.question?.trim());
  if (batch && batch.length > 0) {
    const used = new Set<string>();
    const fields = batch.map((q, i) => {
      let id = q.id?.trim().replace(/[^A-Za-z0-9_-]+/g, "-") || `q${i + 1}`;
      while (used.has(id)) id = `${id}-${i + 1}`;
      used.add(id);
      return questionField(q, id);
    });
    return { tool: "ask_user_question", ...(args.title?.trim() ? { title: args.title.trim() } : {}), fields };
  }
  const q = args as AskQuestion;
  if (q.kind === "confirm") {
    return confirmCard({ tool: "ask_user_question", question: q.question, description: q.details?.trim() || undefined, confirmLabel: q.confirmLabel?.trim(), rejectLabel: q.rejectLabel?.trim() });
  }
  return { tool: "ask_user_question", ...(args.title?.trim() ? { title: args.title.trim() } : {}), fields: [questionField(q, "answer")] };
}

export function createAskUserQuestionExtension(): Extension {
  return defineExtension({
    name: "ask-user-question",
    runtimes: ["pi-durable"],
    tools: [
      defineTool({
        name: "ask_user_question",
        description:
          "Ask the user a single question. Your turn ends and the question is shown to them as a card; their answer arrives at the start of your next turn. Use when requirements are ambiguous, a preference or decision is theirs to make, or you need confirmation before proceeding. Ask one question per call, or batch related questions into one card with `questions` (they are answered together). Set multiSelect to allow several choices, or kind \"confirm\" for yes/no.",
        parameters: Params,
        raisesCard: true,
        async execute(args) {
          const a = args as AskArgs;
          const asked = a.questions?.filter((q) => q.question?.trim()).map((q) => q.question) ?? [];
          if (asked.length === 0 && !a.question?.trim()) {
            return { content: [{ type: "text", text: "ask_user_question needs `question` or a non-empty `questions` list." }], isError: true };
          }
          const sent = asked.length > 0 ? asked.map((q) => `\n- ${q}`).join("") : ` ${a.question}`;
          return {
            content: [{ type: "text", text: `Question${asked.length > 1 ? "s" : ""} sent to the user:${sent}\nYour turn ends here; their answer arrives with your next turn.` }],
            card: askCard(a),
          };
        },
      }),
    ],
  });
}
