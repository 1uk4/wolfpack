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
  hook,
  LiveDoc,
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
/** Entry kind of a plain user message (what supersedes pending cards). */
export const USER_ENTRY_KIND = "pi.user";

export interface CardAnswerData {
  cards: { callId: string; answers: CardAnswers }[];
}

/** What a tool returns to raise a card: model-facing placeholder text, the card in details, and terminate. */
export function cardResult(card: Card, text = "The operator was asked. Your turn ends here; their answer arrives with the next turn."): Omit<ToolExecutionResult, "output"> & { output: { type: "text"; text: string }[] } {
  // Round-trip through JSON: zod output types carry `undefined`-able optionals, details must be plain JSON.
  const details: JsonValue = JSON.parse(JSON.stringify({ [CARD_DETAILS_KEY]: card }));
  return { output: [{ type: "text", text }], details, control: { terminate: true } };
}

/**
 * A one-field confirm card, for tools that gate an action on the operator's yes/no (e.g. `task_done`). Pair with
 * `cardResult` (or return it as `card` from a `raisesCard` tool). The default only pre-selects; it never submits.
 */
export function confirmCard(opts: {
  tool: string;
  question: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
  rejectLabel?: string;
  default?: boolean;
}): Card {
  return {
    tool: opts.tool,
    ...(opts.title ? { title: opts.title } : {}),
    fields: [
      {
        id: "confirm",
        kind: "confirm",
        label: opts.question,
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.confirmLabel ? { confirmLabel: opts.confirmLabel } : {}),
        ...(opts.rejectLabel ? { rejectLabel: opts.rejectLabel } : {}),
        ...(opts.default !== undefined ? { default: opts.default } : {}),
      },
    ],
  };
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
 * Ends the whole round when the model called a card-raising tool in it, alongside other tools: pi-durable terminates
 * only when EVERY result of the round asks for it. Stateless and replay-safe: the round's calls are read from the
 * durable LiveDoc in `afterTool`, nothing is kept in memory.
 * - a card tool's result terminates only when it actually produced a card (not on isError / no card in details);
 *   an erroring card tool therefore keeps the round going, so the model sees the error;
 * - any other tool's result terminates when the round contains a card tool.
 * Card tools are registered per guard (`register`, wired to `adaptToDurable`'s `onCardTool` for that wolf), so nothing
 * leaks across wolves or tests; `extraCardTools` is for native pi-durable extensions that bypass the adapter.
 */
export interface CardGuard {
  extension: Extension;
  /** Record a card-raising tool by name (the `onCardTool` callback of adaptToDurable). */
  register(name: string): void;
  isCardTool(name: string): boolean;
}

export function createCardGuardExtension(extraCardTools: readonly string[] = []): CardGuard {
  const registered = new Set<string>(extraCardTools);
  const isCardTool = (name: string) => registered.has(name);
  const extension = defineExtension({
    name: "card-guard",
    hooks: [
      hook(ToolTask, {
        afterTool: async (call, result, api, context) => {
          if (call.parent) return undefined;
          if (isCardTool(call.name)) return undefined; // cardResult already terminates; an error/no-card result must not
          const live = await api.snapshot(LiveDoc, api.conversationId, context);
          const raises = (live?.tools ?? []).some((t) => isCardTool(t.name));
          return raises ? { ...result, control: { ...result.control, terminate: true } } : undefined;
        },
      }),
    ],
  });
  return { extension, register: (name) => void registered.add(name), isCardTool };
}
