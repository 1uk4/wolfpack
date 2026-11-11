/**
 * THE INPUT-EVENTS CONTRACT (Wave B, owner ruling 2026-09-26: "input
 * events now, in the same pass"): handleChatRequest takes `{chatId, input}`
 * — ONE explicit event, never a client transcript. The server owns the
 * record; a send tells it what HAPPENED, not what the client's list looks
 * like. The 409 merge-retry died with the full-list body (an input event
 * retries idempotently: nothing was appended when a POST is refused).
 *
 * The events (the complete client-originated input taxonomy):
 *   text    — a user-authored message (composer send, initial message)
 *   answer  — the pending question's graded result (QuestionAnswerData,
 *             built client-side exactly as today; a dismissal is an answer
 *             carrying its flag). Server-side this becomes the call's
 *             native tool result — fork 1's normal agent history.
 *   continue — run the next turn on the current record (mount
 *             continuations, job-settle re-syncs: the record ends at an
 *             answered question with no agent reaction yet).
 *
 * Server-originated delivery (the wake pipeline's steers) is NOT a client
 * input — the handler accepts it on the same path (TurnInput) so every
 * turn rides one composition.
 */

import type { QuestionAnswerData } from "./question-core.ts";
import { type UiAttachment } from "./native-messages.ts";

/** One client-originated input event (the POST body's `input`). */
export type ChatInput =
	| { type: "text"; text: string; attachments?: UiAttachment[] }
	| { type: "answer"; toolCallId: string; answer: QuestionAnswerData }
	| { type: "continue" };

