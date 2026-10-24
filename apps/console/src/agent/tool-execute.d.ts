import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
/** Test seam (runner.ts's pdfModelOverride idiom). */
export declare const toolTimeoutMs: {
    current: number;
};
/** The 1.0-native authoring-failure result (pi convention, agent-core
 *  1.0): return an isError result instead of throwing — the model sees the
 *  same retryable problem list it always did (pi minted exactly this shape
 *  from a thrown ToolInputError), but `details` now keeps the problems as
 *  DATA for the record and the UI instead of the throw path's empty {}.
 *  Content text is byte-identical to the old thrown message. */
export declare function invalidInputResult(toolName: string, problems: string[]): AgentToolResult<{
    tool: string;
    problems: string[];
}>;
/**
 * Rich tool-result escape hatch (2026-09 sources v0): a tool whose result
 * includes IMAGES (the read tool reading an image file) returns this shape
 * instead of a plain value — toToolResult maps it to pi's native
 * tool-result content parts (TextContent | ImageContent)[] so the
 * vision-capable model actually SEES the image. `images` carries base64
 * data + mimeType, exactly as pi's ImageContent wants. `details` rides
 * through to the record untouched.
 */
export interface ImageFileResult {
    text: string;
    images?: {
        data: string;
        mimeType: string;
    }[];
    /** The record-facing result (client rendering / persistence). */
    details?: unknown;
}
/**
 * Map a tool body's return to the native AgentToolResult — the parity the
 * old toPiTool tail owned: string results pass verbatim to the model,
 * objects as JSON; `details` carries the RAW value (the record's tool part
 * output reads it, ui-stream), and image results become native content
 * parts with details ?? null.
 */
export declare function toToolResult(result: unknown): AgentToolResult<unknown>;
/** What a server-executed tool's body receives: the call id + the guard's
 *  combined signal (run abort + per-call timeout) for cooperative polling. */
export interface ToolExecuteContext {
    toolCallId: string;
    signal?: AbortSignal;
}
/**
 * Build a native AgentTool execute from a tool body — the guard (timeout +
 * abort cascade) plus the shared result mapping, byte-identical to the old
 * toPiTool pipeline for every server-side tool. Question tools do NOT use
 * this: their placeholder is instant (questionResult below) and their
 * refinement checks run before it.
 */
export declare function serverExecute<P extends TSchema>(toolName: string, schema: P, run: (input: Static<P>, ctx: ToolExecuteContext) => unknown): AgentTool<any>["execute"];
/**
 * The synthetic question-tool result (in-memory only; the record's tool
 * part keeps no output until the learner answers). terminate: true ends
 * the batch natively — pi stops the loop when every finalized result in
 * the batch terminates; the shouldStopAfterTurn stopper covers the mixed
 * batch (question + other calls in one message) that terminate-only
 * semantics would let run on (owner Option A, 2026-09-25).
 */
export declare function questionResult(): AgentToolResult<null>;
/** The practice pose's ack (practice sessions, owner 2026-10-04): unlike
 *  a question, this result is FINAL — it persists (persistTurn filters
 *  only QUESTION_TOOLS placeholders), because the learner's submissions
 *  arrive as MESSAGES, never as this call's result. terminate: true ends
 *  the turn at the pose; the commitment rides the call's arguments. */
export declare function problemResult(): AgentToolResult<null>;
/** The conclude ack: NOT terminate — the turn continues so the same reply
 *  can reveal + pose the next problem. Text single-sourced in contracts
 *  (CONCLUDE_ACK_TEXT — shared with the dismissal-synthesized pair). */
export declare function concludeResult(): AgentToolResult<null>;
//# sourceMappingURL=tool-execute.d.ts.map