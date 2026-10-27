/**
 * ask_user_question for durable wolves: raises an interaction card instead of blocking on a TUI prompt.
 *
 * The tool returns a card + terminate (see engine/cards.ts): the turn ends complete, the thread is marked needs-you,
 * and the operator's answer starts the next turn. Free text (no options), single choice (options + "Other"),
 * multi-select (`multiSelect`) and yes/no (`kind: "confirm"`).
 */
import { showIfProblem, type Card, type CardOption } from "@wolfpack/protocol";
import { confirmCard } from "../engine/cards.js";
import { defineExtension, defineTool, Type, type Extension } from "../extension-api.js";

const OptionSchema = Type.Object({
  label: Type.String({ description: 'Display label. If you recommend an option, place it first and append "(Recommended)".' }),
  value: Type.Optional(Type.String({ description: "Machine-readable value returned for the option. Defaults to the label." })),
  description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const ShowIfSchema = Type.Object(
  {
    field: Type.String({ description: "Id of an EARLIER question in this batch that controls this one." }),
    equals: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "Show when that answer equals this value (option value, or true/false for a confirm)." })),
    oneOf: Type.Optional(Type.Array(Type.String(), { description: "Show when that answer is any of these option values." })),
  },
  { description: "Show this question only when an earlier one has a given answer (give exactly one of equals / oneOf). A hidden question is not asked or required." },
);

const StepSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Step heading." })),
  questions: Type.Array(Type.String(), { description: "Ids of the questions on this step, in order." }),
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
  showIf: Type.Optional(ShowIfSchema),
});

const Params = Type.Object({
  question: Type.Optional(Type.String({ description: "The question to ask the user. Ask one question per call, unless you batch related ones with `questions`." })),
  questions: Type.Optional(
    Type.Array(QuestionSchema, {
      description: "Batch several related questions into ONE card (the user answers them all at once). Use instead of `question`; each entry takes the same fields as a single question.",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Optional card title (useful with `questions`)." })),
  steps: Type.Optional(
    Type.Array(StepSchema, {
      description:
        "Present the batch as a stepped wizard (Back/Next, one Submit) instead of one page: group the question ids into ordered steps. Every question must be on exactly one step. Still ONE card and one answer.",
    }),
  ),
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
  showIf?: { field: string; equals?: string | boolean; oneOf?: string[] };
}

interface AskArgs {
  question?: string;
  questions?: AskQuestion[];
  steps?: { title?: string; questions: string[] }[];
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
  const showIf = q.showIf ? { field: sanitizeId(q.showIf.field), ...(q.showIf.oneOf ? { oneOf: q.showIf.oneOf } : { equals: q.showIf.equals as string | boolean }) } : undefined;
  const base = { id, label: q.question, ...(description ? { description } : {}), ...(showIf ? { showIf } : {}) };
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

const sanitizeId = (id: string): string => id.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
const fieldId = (q: AskQuestion, i: number): string => (q.id ? sanitizeId(q.id) : "") || `q${i + 1}`;

/** Why a call cannot become a card (model-facing), or undefined when it can. */
export function askProblem(args: AskArgs): string | undefined {
  const batch = args.questions ?? [];
  if (batch.length > 0) {
    if (args.question?.trim()) return "ask_user_question: pass either `question` or `questions`, not both.";
    const blank = batch.findIndex((q) => !q.question?.trim());
    if (blank >= 0) return `ask_user_question: questions[${blank}] has no question text.`;
    const seen = new Set<string>();
    for (const [i, q] of batch.entries()) {
      const id = fieldId(q, i);
      if (seen.has(id)) return `ask_user_question: duplicate question id "${id}" (ids must be unique within a card).`;
      const s = q.showIf;
      if (s) {
        if ((s.equals === undefined) === (s.oneOf === undefined)) return `ask_user_question: questions[${i}].showIf needs exactly one of equals / oneOf.`;
        if (!seen.has(sanitizeId(s.field))) return `ask_user_question: questions[${i}].showIf.field "${s.field}" must be the id of an earlier question.`;
      }
      seen.add(id);
    }
    // showIf against the controller's kind (the same rules the card schema enforces)
    for (const [i, q] of batch.entries()) {
      if (!q.showIf) continue;
      const fields = batch.map((x, j) => questionField(x, fieldId(x, j)));
      const why = showIfProblem({ id: fieldId(q, i), ...(fields[i].showIf ? { showIf: fields[i].showIf } : {}) }, fields);
      if (why) return `ask_user_question: questions[${i}].showIf: ${why}.`;
    }
    if (args.steps) {
      const ids = args.steps.flatMap((s) => s.questions.map(sanitizeId));
      const all = batch.map((q, i) => fieldId(q, i));
      if (args.steps.length === 0 || args.steps.some((s) => s.questions.length === 0)) return "ask_user_question: every step needs at least one question id.";
      const unknown = ids.find((i) => !all.includes(i));
      if (unknown) return `ask_user_question: steps references unknown question id "${unknown}".`;
      if (new Set(ids).size !== ids.length || ids.length !== all.length) return "ask_user_question: steps must list every question exactly once.";
      if (ids.some((id, i) => id !== all[i])) return "ask_user_question: steps must keep the questions in their order (step 1 holds the first questions, and so on).";
    }
    return undefined;
  }
  return args.question?.trim() ? undefined : "ask_user_question needs `question` or a non-empty `questions` list.";
}

/** The card for one ask_user_question call (validated with {@link askProblem}): a single question (legacy field ids), or a batch with one field per question. */
export function askCard(args: AskArgs): Card {
  const title = args.title?.trim() ? { title: args.title.trim() } : {};
  if (args.questions && args.questions.length > 0) {
    const steps = args.steps?.map((s) => ({ ...(s.title?.trim() ? { title: s.title.trim() } : {}), fields: s.questions.map(sanitizeId) }));
    return { tool: "ask_user_question", ...title, fields: args.questions.map((q, i) => questionField(q, fieldId(q, i))), ...(steps ? { steps } : {}) };
  }
  const q = args as AskQuestion;
  if (q.kind === "confirm") {
    return confirmCard({ tool: "ask_user_question", question: q.question, description: q.details?.trim() || undefined, confirmLabel: q.confirmLabel?.trim(), rejectLabel: q.rejectLabel?.trim() });
  }
  return { tool: "ask_user_question", ...title, fields: [questionField(q, "answer")] };
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
          const problem = askProblem(a);
          if (problem) return { content: [{ type: "text", text: problem }], isError: true };
          const asked = a.questions?.length ? a.questions.map((q) => q.question) : [];
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
