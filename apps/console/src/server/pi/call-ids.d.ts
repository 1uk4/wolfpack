import type { AgentEvent } from "@earendil-works/pi-agent-core";
/** The ids every consumer may already have seen: all call ids and result
 *  ids in a message list (the chat record — including its legacy dupes,
 *  which is the point: membership is what drives minting). */
export declare function collectToolCallIds(messages: readonly unknown[]): string[];
export declare class ToolCallIdUniquifier {
    private readonly seen;
    /** assistant message object → its (origId → uniqueId) table. Weak: the
     *  agent's turn dies at settle; nothing here outlives it. */
    private readonly tables;
    /** The current assistant message's table — opened at its message_start,
     *  shared by its update/end objects, and the resolution scope for its
     *  tool_execution events (which fire after its message_end but before
     *  the next message_start). */
    private epoch;
    constructor(usedIds: Iterable<string>);
    /** Keep `orig` if never used; otherwise mint an unused `${orig}~n`. */
    private claim;
    /** Register + rewrite one message's tool-call blocks (idempotent across
     *  the repeated partials of message_update). Returns a cloned message
     *  when any id changed, else the original object. */
    private remapMessageContent;
    /** Every AgentEvent, ids uniquified. Structural and total: unknown
     *  event shapes pass through untouched. */
    event(event: AgentEvent): AgentEvent;
    private remapEventMessage;
    /** The settle seam: the agent's final state, rewritten to the ids the
     *  wire already showed. Only THIS turn's messages rewrite (the ones
     *  registered by their event objects); prior-turn history — including
     *  legacy duplicate-id records — passes through verbatim. Tool results
     *  pair with the most recent registered assistant message (the loop's
     *  own structure: results follow their calls). */
    remapSettled(messages: readonly unknown[]): unknown[];
}
//# sourceMappingURL=call-ids.d.ts.map