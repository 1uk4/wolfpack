/**
 * Card channel of the engine tool result.
 *
 * A tool raises an interaction card by returning `cardResult(card)`: the card rides the result's `details` (durable,
 * so wolfd re-derives pending cards from the transcript after a restart or reconnect) and `control.terminate` ends
 * the run without another model request, so the turn closes `complete`. The operator's answer is a submission placed
 * as a `CARD_ANSWER_KIND` entry: the next turn starts with it, and the thread history folds it onto the call that
 * raised the card (ThreadToolCall.answer / result). A plain user submission placed after a card supersedes it.
 *
 * pi-durable ends a run only when EVERY result of the round asks to terminate. `createCardGuardExtension` makes a
 * round that contains a card-raising call terminate as a whole, so a card is never left pending while the run goes on.
 */
import type { JsonValue } from "@earendil-works/chord";
import {
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
  type Extension,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { Card, CardAnswers } from "@wolfpack/protocol";
import { CardSchema } from "@wolfpack/protocol";

/** Key of the card inside a tool result's `details`. */
export const CARD_DETAILS_KEY = "wolfpackCard";
/** Entry kind an answer submission is placed as. `data` is {@link CardAnswerData}. */
export const CARD_ANSWER_KIND = "wolfpack.card-answer";

export interface CardAnswerData {
  cards: { callId: string; answers: CardAnswers }[];
}

/** What a tool returns to raise a card: model-facing placeholder text, the card in details, and terminate. */
export function cardResult(card: Card, text = "The operator was asked. Your turn ends here; their answer arrives with the next turn."): Omit<ToolExecutionResult, "output"> & { output: { type: "text"; text: string }[] } {
  // Round-trip through JSON: zod output types carry `undefined`-able optionals, details must be plain JSON.
  const details: JsonValue = JSON.parse(JSON.stringify({ [CARD_DETAILS_KEY]: card }));
  return { output: [{ type: "text", text }], details, control: { terminate: true } };
}

/** The card a tool-result message carries in `details`, if any (validated; a malformed one is ignored). */
export function cardOfToolMessage(message: unknown): Card | undefined {
  const raw = (message as { details?: Record<string, unknown> } | undefined)?.details?.[CARD_DETAILS_KEY];
  if (raw === undefined) return undefined;
  const parsed = CardSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The entry data of an answer submission, as the engine stores it (plain JSON). */
export function cardAnswerEntry(data: CardAnswerData): { kind: string; data: JsonValue } {
  return { kind: CARD_ANSWER_KIND, data: JSON.parse(JSON.stringify(data)) };
}

/**
 * Forces the whole round to end when the model called a card-raising tool (`cardTools`) in it, alongside other tools:
 * every result of such a round gets `control.terminate`. The other tools still run (they were issued in parallel), and
 * their results are in the transcript when the answer starts the next turn.
 */
export function createCardGuardExtension(cardTools: readonly string[]): Extension {
  const names = new Set(cardTools);
  const marked = new Set<string>(); // conversation ids whose current round raises a card
  return defineExtension({
    name: "card-guard",
    hooks: [
      hook(GenerationTask, {
        afterResponse: (message, api) => {
          const id = String(api.conversationId);
          if (message.content.some((b) => b.type === "toolCall" && names.has(b.name))) marked.add(id);
          else marked.delete(id);
        },
        afterTools: (_assistant, _results, api) => {
          marked.delete(String(api.conversationId));
        },
      }),
      hook(ToolTask, {
        afterTool: (_call, result, api) => (marked.has(String(api.conversationId)) ? { ...result, control: { ...result.control, terminate: true } } : undefined),
      }),
    ],
  });
}
