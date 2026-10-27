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

const Params = Type.Object({
  question: Type.String({ description: "The single question to ask the user. Ask exactly one question per tool call." }),
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

interface AskArgs {
  question: string;
  details?: string;
  options?: { label: string; value?: string; description?: string }[];
  multiSelect?: boolean;
  kind?: "confirm";
  confirmLabel?: string;
  rejectLabel?: string;
}

/** The card for one ask_user_question call. */
export function askCard(args: AskArgs): Card {
  const options: CardOption[] = (args.options ?? [])
    .map((o) => ({ label: o.label.trim(), value: o.value?.trim() || o.label.trim(), ...(o.description?.trim() ? { description: o.description.trim() } : {}) }))
    .filter((o) => o.label.length > 0);
  const description = args.details?.trim() || undefined;
  if (args.kind === "confirm") {
    return confirmCard({ tool: "ask_user_question", question: args.question, description, confirmLabel: args.confirmLabel?.trim(), rejectLabel: args.rejectLabel?.trim() });
  }
  const base = { id: "answer", label: args.question, ...(description ? { description } : {}) };
  const field: Card["fields"][number] =
    options.length === 0 ? { ...base, kind: "free-text" } : args.multiSelect ? { ...base, kind: "multi", options, allowOther: true } : { ...base, kind: "single", options };
  return { tool: "ask_user_question", fields: [field] };
}

export function createAskUserQuestionExtension(): Extension {
  return defineExtension({
    name: "ask-user-question",
    runtimes: ["pi-durable"],
    tools: [
      defineTool({
        name: "ask_user_question",
        description:
          "Ask the user a single question. Your turn ends and the question is shown to them as a card; their answer arrives at the start of your next turn. Use when requirements are ambiguous, a preference or decision is theirs to make, or you need confirmation before proceeding. Ask exactly one question per call. Set multiSelect to allow several choices, or kind \"confirm\" for yes/no.",
        parameters: Params,
        raisesCard: true,
        async execute(args) {
          const a = args as AskArgs;
          return {
            content: [{ type: "text", text: `Question sent to the user: ${a.question}\nYour turn ends here; their answer arrives with your next turn.` }],
            card: askCard(a),
          };
        },
      }),
    ],
  });
}
