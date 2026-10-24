/**
 * THE VIEW MODEL (Wave D, owner-approved 2026-09-26): the client's transcript
 * view — native record messages (+ the live turn's working messages) grouped
 * into today's exact render shape. The golden master is the pre-Wave-D UI
 * (owner fork 1): everything the agent produces is ONE continuous document
 * per run — step separators between the loop's steps, artifact and answered
 * cards inline, the teacher's reaction continuing below an answered quiz.
 *
 * This is the grouping canon of the deleted server-side projection
 * (core/projection.ts, Wave B), moved client-side, app-owned, with zero AI-SDK
 * types — plus the LIVE-TURN layer the projection never had: mid-turn tool
 * execution states (input-streaming → input-available/output-error/output),
 * so the dock mounts only after a call clears the validation boundary
 * (tool_execution_end) and the shimmer names the running activity.
 *
 * GROUPING RULE: one assistant view message per GROUP — consecutive assistant
 * + toolResult messages, bounded by user/marker messages; toolResults attach
 * to the tool part of their call (searching backward — an answered quiz's
 * result lands on the part that asked it, even turns later); a group's id is
 * its FIRST assistant message's id.
 *
 * Plan blocks: a plan-block marker has no message of its own — its data part
 * splices into the preceding assistant group, IN FLOW right after the last
 * successful plan_init call (the presentation moment).
 *
 * Question tools on the wire (owner fork 2): the agent's closing
 * tool_execution_end carries the in-memory "Question posed" placeholder —
 * projectView IGNORES clean question executions (the part stays
 * input-available; the learner's answer arrives as a real toolResult). The
 * placeholder never persists, so settled records never see it.
 *
 * Pure and deterministic: client-safe (no node deps), same input → same view.
 */
import type { LhMessage } from "./native-messages.ts";
/** A view part — the loose part vocabulary the renderers consume (the same
 *  shape names the pre-Wave-D UIMessage dialect used, so the renderer
 *  switch and the phase/pending scanners transplant unchanged). The common
 *  fields are optional-typed so the pre-Wave-D renderer code compiles
 *  against it with minimal casts; anything else stays `unknown` through
 *  the index signature. */
export interface LhViewPart extends Record<string, unknown> {
    type: string;
    id?: string;
    text?: string;
    state?: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    rawInput?: unknown;
    errorText?: string;
    data?: unknown;
}
/** A view message: user (bubble) or assistant (one continuous run). */
export interface LhViewMessage {
    id: string;
    role: "user" | "assistant";
    parts: LhViewPart[];
    /** The subagentResult meta the steer cards read (marker details). */
    metadata?: unknown;
}
/** A tool call's live execution outcome (from tool_execution_end). */
export interface LiveExecution {
    isError: boolean;
    /** The clean result's details payload (the card's output). */
    output?: unknown;
    /** The failure text (output-error parts). */
    errorText?: string;
}
/** The live turn's execution layer, maintained by the session hook. */
export interface LiveTurnState {
    /** toolCallId → its execution outcome seen so far. */
    executions: ReadonlyMap<string, LiveExecution>;
    /** True while the turn runs — calls with no execution yet render
     *  input-streaming (the shimmer); settled dangling calls render
     *  input-available (the dock mounts from the record). */
    inFlight: boolean;
    /** Ids of the messages THIS consume is streaming (optimistic round 3,
     *  2026-10-02): an arrived-but-empty streaming message projects one
     *  empty reasoning part — the thinking row — so the placeholder's
     *  handoff is seamless; settled empty messages stay hidden. */
    streamingIds: ReadonlySet<string>;
}
/** Project the native record (+ live turn working list) into the client's
 *  view messages. Pure: the same input always projects to the same list. */
export declare function projectView(messages: readonly LhMessage[], live?: LiveTurnState): LhViewMessage[];
//# sourceMappingURL=view.d.ts.map