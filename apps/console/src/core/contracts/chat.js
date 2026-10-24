/** The chat record format this build writes and understands. */
export const CURRENT_CHAT_VERSION = 1;
// ─── Plan blocks (the plan lives in the chat) ────────────────────────────────
/** Payload of the persisted `data-plan-block` UI part (2026-09 design): a
 * SNAPSHOT of the plan at the moment it changed, rendered as a block in the
 * chat flow. Attached to the assistant message that carries the plan_init
 * tool call (kind "full") or the answered check quiz part (kind
 * "neighborhood"). Data parts never reach the model (convertToModelMessages
 * drops them) — the block is pure UI history, reappearing identically on
 * reload because it lives in the record.
 *
 * Rendering contract: a "full" block renders the whole DAG borderless,
 * horizontally filling the chat column, natural height; a "neighborhood"
 * block renders current node + direct parents + direct children in its own
 * small container, the current node glowing — clearly a fragment, not the
 * whole plan. Clicking either opens the full plan in a popup. */
/** The model-facing text of the probe→teach handoff wake (the custom-message
 *  scheme): the wake message carries only the data-probe-handoff part, and
 *  the adapter flattens it to THIS. Single-sourced so the prober's seam, the
 *  tests, and reality can't drift apart.
 *
 *  REASONING-FIRST PACING (owner, 2026-09-26): the wake is the one per-turn
 *  cue on the launch turn — the old one-liner read as a dispatch order
 *  ("author now") and the teacher skipped the deliberation the planning
 *  fragment asks for. So the wake paces it: reason out the optimal way to
 *  teach THIS person THIS thing BEFORE plan_init. Honest to the machinery
 *  — plan_init is still the first tool, the plan map still the first
 *  artifact, and presenting still ends the turn (the verdict death,
 *  2026-09-26: the learner's next message is a natural reply — a change
 *  request or the go-ahead). */
export const HANDOFF_TEXT = "Next: plan the full teaching arc from my current understanding to the goal understanding. " +
    "Apply the teaching methodology in your system prompt, and find the optimal way to teach me this. " +
    "Find the unconditional truths, plan the motivated derivations/discoveries, so every reasoning step has to land as obviously true. " +
    "Take your time here and really think this through. " +
    "When it's genuinely reasoned out, call plan_init and present the plan; I'll accept it or ask for changes.";
// ─── Practice sessions (owner, 2026-10-04) — marker + ack texts ──────────────
// Single-sourced here per the marker law: the model-facing text of every
// custom marker lives in core/contracts, never in the flattening seam.
/** The model-facing register of a thinking submission (newThinkingMessage
 *  prefixes the learner's text with this label). Hints and commits ride
 *  one channel — the label is the ONLY difference the model sees. */
/** The single submission label (owner round, 2026-10-05): one send
 *  lane — whether a submission claims an answer is read from the text,
 *  not declared by a button. */
export const THINKING_LABEL = "Your thinking";
/** The conclude tool's ack — shared by the executed call (agent layer) and
 *  the dismissal-synthesized pair (input-events), so a concluded problem
 *  reads identically to the model however it concluded. Owner round 16:
 *  the turn ENDS after concluding (a system-prompt law, no tool-level
 *  terminate — the model may speak its closing words first, then must
 *  stop calling tools); the next problem waits for the learner's
 *  explicit go-ahead. */
export const CONCLUDE_ACK_TEXT = "Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.";
/** The learner's explicit move-on signal (owner round 16, 2026-10-06):
 *  the model-facing text of the practice-next marker — single-sourced
 *  like THINKING_LABEL. The button/Enter-on-empty path appends the
 *  marker; the model reads this and poses (or wraps) per the doctrine. */
export const NEXT_PROBLEM_TEXT = "[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.";
/** The compaction marker's model-facing header (owner round 14,
 *  2026-10-05). The marker's content is this header + the summary — the
 *  single text the provider sees in place of the dropped span. Wording
 *  law: it must tell the model (a) a cut happened and is routine, (b) the
 *  summary replaces everything before it, (c) what follows is verbatim
 *  recent transcript — so the model neither re-asks covered ground nor
 *  distrusts the seam. */
export const COMPACTED_HISTORY_HEADER = "[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.";
//# sourceMappingURL=chat.js.map