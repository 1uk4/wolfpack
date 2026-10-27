/**
 * Card channel of the engine tool result.
 *
 * A tool raises an interaction card by returning `cardResult(card)`: the card rides the result's `details` (durable,
 * so wolfd re-derives pending cards from the transcript after a restart or reconnect) and `control.terminate` ends
 * the run without another model request, so the turn closes `complete`. The operator's answer is a submission placed
 * as a `CARD_ANSWER_KIND` entry: the next turn starts with it, and the thread history folds it onto the call that
 * raised the card (ThreadToolCall.answer / result).
 */
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
export function cardResult(card: Card, text = "The operator was asked. Your turn ends here; their answer arrives with the next turn.") {
  return {
    output: [{ type: "text" as const, text }],
    details: { [CARD_DETAILS_KEY]: card } as never,
    control: { terminate: true },
  };
}

/** The card a tool-result message carries in `details`, if any (validated; a malformed one is ignored). */
export function cardOfToolMessage(message: unknown): Card | undefined {
  const raw = (message as { details?: Record<string, unknown> } | undefined)?.details?.[CARD_DETAILS_KEY];
  if (raw === undefined) return undefined;
  const parsed = CardSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
