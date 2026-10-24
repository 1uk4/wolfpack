/**
 * THE NATIVE MESSAGE RECORD (Wave B, owner-approved 2026-09-26): chat
 * records store pi's own message shapes — the exact history the agent
 * loop builds — instead of AI-SDK UIMessages. Provider, model, usage,
 * stopReason, and thinking signatures are stamped by pi itself; replay is
 * `state.messages = record.messages` + `continue()` — the record IS the
 * agent state.
 *
 * WHY pi MESSAGES LACK OUR `id`: pi's session format gives every ENTRY an
 * id, never the message. This app needs a per-message id for client
 * identity (React keys, append-only adoption, the continuation seam), so
 * every record message carries ONE extra field — `id` — alongside the
 * native shape. `toLlmMessages` strips it at the wire: the provider never
 * sees it (verified single site, below).
 *
 * UI-ONLY CONTENT (owner ruling, fork 1 + the plan's custom-message
 * taxonomy): the probe→teach handoff, sub-agent steers,
 * and plan blocks are LhMarkerMessage — this app's declaration-merged
 * member of pi-agent-core's CustomAgentMessages extension point, shaped
 * exactly like pi's own CustomMessage ({role:"custom", customType,
 * content, display, details}). ONE seam — toLlmMessages, wired as the
 * agent's convertToLlm — owns every model-facing decision: markers
 * flatten to their canonical user text (single-sourced in
 * core/contracts), plan blocks are UI-only and filtered, and dangling
 * tool calls (an aborted turn) get the interrupted-result synthesis the
 * provider protocol demands.
 *
 * Answers (fork 1, owner 2026-09-26): the learner's answer IS the tool
 * call's ToolResultMessage — appended natively at answer time. The
 * synthetic "question posed" placeholder is an in-memory loop device
 * (Wave A's terminate) and is never persisted: the record ends at the
 * unanswered call in the pose→answer window, where no turn can run (the
 * question gate holds steers; a POST would 409).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
/** The hard-invariant wording for an aborted turn's unanswered calls —
 *  carried over verbatim from the pre-native era so the model's view
 *  never drifted. */
export declare const INTERRUPTED_TEXT = "The question was interrupted \u2014 the learner never answered; continue without holding a result for it.";
/**
 * The app's custom message (declaration-merged into pi-agent-core's
 * CustomAgentMessages below). Shaped like pi's own CustomMessage —
 * `content` is the MODEL-facing text (single-sourced in core/contracts,
 * never fake human speech), `details` is the UI payload (never
 * model-visible), `display` marks messages the UI renders (our projection
 * keys rendering on customType; the flag documents intent).
 */
export interface LhMarkerMessage {
    /** Record identity (pi messages carry no id — see the file header). */
    id: string;
    role: "custom";
    customType: "graph-context" | "probe-handoff" | "subagent-steer" | "subagent-abort" | "plan-block" | "practice-thinking" | "practice-next" | "problem-dismissed" | "compaction";
    /** The model-facing text ("" for plan blocks — UI-only). */
    content: string;
    display: boolean;
    /** The UI payload — per-customType, never model-visible. */
    details: unknown;
    timestamp: number;
}
declare module "@earendil-works/pi-agent-core" {
    interface CustomAgentMessages {
        lhMarker: LhMarkerMessage;
    }
}
/** A record message: a native pi message (or our marker) plus the record id. */
export type LhMessage = (UserMessage | AssistantMessage | ToolResultMessage | LhMarkerMessage) & {
    id: string;
};
/** A record message list is assignable to the agent's context — that IS
 *  the replay (ui-stream/chat-handler assign it to initialState.messages). */
export declare function asAgentMessages(messages: readonly LhMessage[]): AgentMessage[];
/** The app-wide message id shape (same as the UIMessage-era mint). */
export declare function newMessageId(): string;
/** A learner-authored user message (text input, verdict note). */
export declare function newUserMessage(text: string): LhMessage & UserMessage;
/** A steered user message (mid-turn composer steering, owner 2026-10-03):
 *  a plain user message with the CLIENT-minted steer id — the same object
 *  rides agent.steer(), the live stream's message events, and the settled
 *  record, so the optimistic queued indicator and the transcript card
 *  upsert by one identity. */
export declare function newUserSteer(text: string, id: string): LhMessage & UserMessage;
/** The learner's answer — the question call's tool result (fork 1).
 *  TWO AUDIENCES (owner, tool-result diet 2026-10-02): the MODEL sees the
 *  compact learner-only record (compactAnswerForModel — the call's own
 *  arguments already carry the question/options/explanation/commitment;
 *  restating them doubled every answer's tokens), while `details` keeps
 *  the FULL graded QuestionAnswerData for the record and the UI. */
export declare function newAnswerResult(toolCallId: string, toolName: string, answer: unknown): LhMessage & ToolResultMessage;
/** The probe→teach handoff wake: scaffolding, not speech — the model reads
 *  HANDOFF_TEXT, the UI renders the quiet system line. */
export declare function newHandoffMessage(chatId: string): LhMarkerMessage;
/** The plan presentation block: pure UI history (a frozen snapshot), no
 *  model face — toLlmMessages filters it. `planCallId` keys idempotent
 *  emission (one block per successful plan_init call). */
export declare function newPlanBlockMessage(planCallId: string, block: unknown): LhMarkerMessage;
/** The practice agent's two tools (the conclude-before-next-problem gate's
 *  vocabulary — the tool-execute layer owns the tools themselves). */
export declare const PRACTICE_PROBLEM_TOOL = "problem";
export declare const PRACTICE_CONCLUDE_TOOL = "conclude";
/** One picked proposition of the graph-context marker (the learner's map
 *  pick — name + statement as the learner SAW them at pick time). */
export interface GraphContextPick {
    id: string;
    name: string;
    statement: string;
}
/** The session's map context (owner, 2026-10-04): a SEPARATE custom
 *  message BEFORE the learner's first user message — the picked
 *  propositions plus the reasoning chains among them (pre-formatted
 *  lines, formatChainLine shape). The model reads `content` (flattened
 *  to a user message by toLlmMessages like every marker); `details`
 *  feeds the transcript's collapsible GraphContextCard. No more seed
 *  text glued into the first prompt. */
export declare function newGraphContextMessage(picks: readonly GraphContextPick[], chains: readonly string[]): LhMarkerMessage;
/** The learner's thinking submission (ONE send lane, owner round
 *  2026-10-05): the register is no longer declared by a button — the
 *  model READS the text to tell working traces from claimed answers. The
 *  content label is the single "Your thinking"; `details` keeps the raw
 *  payload for the transcript card. One problem may carry many
 *  submissions. */
export declare function newThinkingMessage(problemCallId: string, text: string): LhMarkerMessage;
/** The learner's explicit move-on signal (owner round 16): appended by
 *  the next input (the composer band's chip, or Enter on an empty
 *  composer during the between-problems pause). The content is the
 *  single-sourced NEXT_PROBLEM_TEXT — the model's unambiguous go-ahead;
 *  the transcript renders its own compact line off the marker (never
 *  the content). */
export declare function newNextMessage(): LhMarkerMessage;
/** The problem-dismissal marker (ask-style discard, owner 2026-10-04):
 *  UI-ONLY — toLlmMessages filters it. The model's face arrives later, at
 *  the user's next input, as the synthesized conclude pair
 *  (concludedByDismissalPair below) — the agent sees the dismissal as a
 *  conclude call it "made" with outcome "dismissed", so the slot-freed
 *  state and the dismissal read through the one vocabulary it owns. */
export declare function newProblemDismissedMarker(problemCallId: string): LhMarkerMessage;
/** The dismissal's deferred conclude (owner ruling 2026-10-04): the pair
 *  prepended to the user's NEXT input — a synthetic assistant message
 *  carrying a conclude call (outcome "dismissed") plus its ack result, so
 *  both the record and the model context read the problem as concluded
 *  by dismissal, slot freed. Pure; ids are deterministic off the problem
 *  call id (idempotent shape — the pending-dismissal gate guarantees the
 *  pair appends at most once per marker). */
export declare function concludedByDismissalPair(problemCallId: string): [LhMessage & AssistantMessage, LhMessage & ToolResultMessage];
/** The conclusion's reveal (owner round, 2026-10-05): the hero of a
 *  conclude card is the modelSolution committed at POSE time — the newest
 *  cleanly-posed problem BEFORE this conclude call. The reveal is never
 *  re-authored (the slim schema dropped solutionReveal); legacy conclude
 *  inputs that still carry their own solutionReveal fall back to it at the
 *  card. Undefined when the pose carries no string solution. */
export declare function modelSolutionForConclude(messages: readonly LhMessage[], concludeCallId: string): string | undefined;
/** The full pose-side fold (owner round 17, 2026-10-06 — observability):
 * EVERYTHING the agent filled into the problem call — mode, target ids,
 * statement, the committed solution — joined onto the conclude part so
 * the card's collapsible "agent's data" drawer renders pure. Same walk
 * and refusal law as the reveal: a pose the record never acked (a
 * refused call) folds nothing. */
export declare function problemInputForConclude(messages: readonly LhMessage[], concludeCallId: string): {
    statement?: unknown;
    mode?: unknown;
    target?: unknown;
    modelSolution?: unknown;
} | undefined;
export declare function activeProblemOf(messages: readonly LhMessage[]): {
    toolCallId: string;
    input: unknown;
} | null;
/** Is a problem-dismissal marker waiting for its conclude synthesis? The
 *  text/continue appends read this: the pair rides the user's next input
 *  (input-events). Newest-marker-wins scan: the first dismissal marker or
 *  conclude call from the end decides. */
export declare function pendingProblemDismissalOf(messages: readonly LhMessage[]): string | null;
/**
 * AgentMessage[] → the provider wire (the agent's convertToLlm — required
 * by pi-agent-core's loop config, the ONE place model-facing decisions
 * live):
 *
 * - user / assistant / toolResult pass through VERBATIM — signatures,
 *   usage, provider stamps all native — minus our record-`id` field.
 * - markers flatten to a user message carrying their content (the
 *   canonical text single-sourced in core/contracts); plan blocks are
 *   UI-only and filtered.
 * - dangling tool calls (an aborted turn's unanswered questions) get the
 *   synthesized interrupted result — the provider protocol's hard
 *   invariant: a tool call must be followed by its result.
 *
 * Contract (pi-agent-core): never throws — an unknown shape passes
 * through untouched rather than killing the loop.
 */
export declare function toLlmMessages(messages: readonly AgentMessage[]): Message[];
/** The pending-question gate (findPendingToolCall's native twin): the
 *  NEWEST assistant message's FIRST question-tool call with no result in
 *  the tail — one question at a time, the dock's subject. */
export declare function danglingQuestionOf(messages: readonly LhMessage[]): {
    toolCallId: string;
    tool: string;
    input: unknown;
} | null;
/** The probe→teach construction seam (chat-handler): a probe_done call in
 *  the transcript — any state — means the probe is concluded: teach. */
export declare function hasProbeDone(messages: readonly LhMessage[]): boolean;
/** Every toolResult id in the record — answer-event validation (the call
 *  must be a DANGLING question call, not an already-answered one). */
export declare function answeredCallIds(messages: readonly LhMessage[]): Set<string>;
/** The dismissal pause (owner design 2026-10-03, "A2"): the record ends
 *  in user dismissal — the session waits for the USER. While paused,
 *  nothing auto-wakes: the continuation fold demands nothing (below) and
 *  the wake pipeline holds job deliveries in the steer queue until the
 *  next send. Derived from the tail — no latch to persist or clear; any
 *  user message flips it off by changing the record. */
export declare function endsInDismissal(messages: readonly LhMessage[]): boolean;
export declare function needsContinuation(messages: readonly LhMessage[]): boolean;
//# sourceMappingURL=native-messages.d.ts.map