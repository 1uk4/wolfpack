/**
 * Practice-flow integration test (practice sessions, owner design
 * 2026-10-04) — the full practice loop with zero tokens, mirroring
 * chat-flow.test.ts's harness (handleChatRequest + the faux engine):
 *
 *   learner opens → practice agent poses (problem, terminate) → thinking
 *   arrives as a labeled message → agent concludes + reveals + wraps
 *   → Esc dismissal synthesizes the conclude pair on the next input.
 *
 * The record law under pin: the pose ack PERSISTS (unlike a question's
 * placeholder) and a record ending on it owes no continuation.
 */
export {};
//# sourceMappingURL=practice-flow.test.d.ts.map