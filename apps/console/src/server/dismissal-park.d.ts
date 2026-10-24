/**
 * PARKED DISMISSALS (owner, 2026-10-04): ESC-discard while the turn is
 * still working. Mid-turn the STORED record holds no pending question or
 * problem (the turn hasn't persisted — its messages land at settle), so a
 * dismissal arriving now CANNOT validate; the old behavior was a hard 409,
 * which left the learner trapped with a phantom question until the turn
 * died (the GLM practice-loop incident: the only escape was killing the
 * dev server).
 *
 * The park (owner ruling: "server-side park"): the dismiss route, finding
 * a live turn, parks the intent and answers 202; the turn's settle path
 * (chat-handler onFinish, AFTER persistTurn, BEFORE endTurn — the same
 * ordering law that makes turn-settled imply durable truth) applies it
 * against the freshly persisted record. Validation runs at APPLY time
 * against real state: if the dismissed question/problem really is pending
 * there, the dismissal lands exactly as the route would have written it;
 * if it never materialized (the call errored, the model re-posed and
 * answered), the park is dropped silently — the thing the user dismissed
 * no longer exists.
 *
 * Lives on globalThis, NOT a module-level Map — the same Next.js module
 * instance discipline as turn-liveness: the dismiss route and the
 * chat-handler entry must see the SAME registry or the park is written in
 * one world and read in another. Ephemeral by design; one parked
 * dismissal per chat (last write wins — there is one dock, one discard).
 */
import type { ChatStore } from "../core/ports.ts";
/** The parked dismissal body — exactly the parsed input the dismiss route
 *  accepted ({type:"dismiss", toolCallId, answer} or
 *  {type:"dismiss-problem", problemCallId}). */
export type ParkedDismissal = unknown;
/** Park (or overwrite) the chat's dismissal intent. Called by the dismiss
 *  route when a turn owns the chat. */
export declare function parkDismissal(chatId: string, input: ParkedDismissal): void;
/** Take the chat's parked dismissal (removes it). Returns null when
 *  nothing is parked. */
export declare function takeParkedDismissal(chatId: string): ParkedDismissal | null;
/** Apply the chat's parked dismissal, if any, against the current record.
 *  Runs in the turn's onFinish — between persistTurn and endTurn, so a
 *  client reacting to "turn-settled" reads the dismissal already in the
 *  record. The append path is the route's own (dismissAppends); a
 *  ChatInputError means the dismissed thing never materialized — the park
 *  is dropped, silence is the correct outcome. Emits "record-changed"
 *  exactly when something was written. */
export declare function applyParkedDismissal(chatStore: ChatStore, chatId: string): void;
//# sourceMappingURL=dismissal-park.d.ts.map