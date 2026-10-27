/**
 * ask_user_question for durable wolves: raises an interaction card instead of blocking on a TUI prompt.
 *
 * The tool returns a card + terminate (see engine/cards.ts): the turn ends complete, the thread is marked needs-you,
 * and the operator's answer starts the next turn. Free text (no options) and single choice (options + "Other") for now;
 * multi-select and confirm arrive with the multi/confirm field kinds.
 */
import type { Card, CardOption } from "@wolfpack/protocol";
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
});

interface AskArgs {
  question: string;
  details?: string;
  options?: { label: string; value?: string; description?: string }[];
}

/** The card for one ask_user_question call. */
export function askCard(args: AskArgs): Card {
  const options: CardOption[] = (args.options ?? [])
    .map((o) => ({ label: o.label.trim(), value: o.value?.trim() || o.label.trim(), ...(o.description?.trim() ? { description: o.description.trim() } : {}) }))
    .filter((o) => o.label.length > 0);
  const description = args.details?.trim() || undefined;
  const base = { id: "answer", label: args.question, ...(description ? { description } : {}) };
  return {
    tool: "ask_user_question",
    fields: [options.length > 0 ? { ...base, kind: "single", options } : { ...base, kind: "free-text" }],
  };
}

export function createAskUserQuestionExtension(): Extension {
  return defineExtension({
    name: "ask-user-question",
    runtimes: ["pi-durable"],
    tools: [
      defineTool({
        name: "ask_user_question",
        description:
          "Ask the user a single question. Your turn ends and the question is shown to them as a card; their answer arrives at the start of your next turn. Use when requirements are ambiguous, a preference or decision is theirs to make, or you need confirmation before proceeding. Ask exactly one question per call.",
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
