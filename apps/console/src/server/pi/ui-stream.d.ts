import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
/**
 * THE NATIVE WIRE (Wave D, owner-approved 2026-09-26): one agent turn, streamed
 * to every view as pi AgentEvents — no translation, no part assembly. The one
 * sanctioned rewrite (the Lacan fix, 2026-10-04): tool-call IDs uniquify at
 * this boundary when the provider resets them per response (DeepSeek's
 * `call_0` every turn) — see call-ids.ts and PiTurnSpec.usedToolCallIds.
 * The SSE body is the agent's own event stream:
 *
 *   data: {"type":"agent_start"}\n\n
 *   data: {"type":"message_update","message":{…}}\n\n
 *   …
 *   data: {"type":"agent_end","messages":[…]}\n\n
 *   data: [DONE]\n\n
 *
 * Load-bearing protocol facts (verified against pi-agent-core):
 * - Every `message_update` carries the FULL partial assistant message (each
 *   AssistantMessageEvent ships `partial`) — a view REPLACES its streaming
 *   assistant with `event.message`; no delta assembly exists anywhere.
 * - WIRE DIET (owner, 2026-10-09 — the streaming-freeze postmortem): our
 *   boundary emits the SLIM message_update (`message` only). pi's event also
 *   carries the same full partial a SECOND time as `assistantMessageEvent`
 *   — nothing in this app ever reads it, and re-serializing it per chunk
 *   doubled every stream frame. Client reads `event.message`, always.
 * - Question tools (quiz / ask_user_question): NO suppression (owner ruling,
 *   Wave D fork 2) — the closing `tool_execution_end` with the in-memory
 *   "Question posed" placeholder flows to the client, which ignores it
 *   (question tools are client-owned; the answer arrives as the input event).
 *   The placeholder still never persists and never reaches the model.
 * - Tool-call validation gating survives by construction: `tool_execution_end`
 *   only fires after the call cleared the boundary (an invalid call arrives
 *   as isError — never a clean end), so the dock's mount rule keys on it.
 * - App-level events beyond pi's taxonomy: the reattach terminal
 *   {"type":"turn-settled"} (served by turn-runs when no turn is running) and
 *   the loop-level {"type":"error","errorText"} (agent.continue() threw
 *   outside the event stream — mapped through the handler's masking policy).
 * - Stream-level provider errors ride their message verbatim
 *   (message_end with stopReason "error" + errorMessage).
 *
 * BACKGROUND-TURN RUNNER (owner ruling, 2026-09-25): a turn executes as a
 * server-side background object decoupled from any single HTTP response —
 * clients are VIEWS. runPiTurn returns the handle (compacted state +
 * subscriber set); piTurnResponse wraps a subscriber stream as the SSE
 * response, and the POST /api/chat response and GET /api/chats/[id]/stream
 * are BOTH exactly that. Cancelling a view detaches it ONLY — never aborts
 * the turn; the handle's abort() is the one remote kill.
 *
 * THE COMPACTION LAW (owner, 2026-10-09 — supersedes the unbounded-log ruling
 * of 2026-09-25): the turn log stores STATE, not chunks. pi's native events
 * are full snapshots — one per provider chunk — so retaining every one made
 * memory and replay cost quadratic in message length (a single
 * high-thinking message retained hundreds of MB and every reattach
 * re-serialized the whole history in one blocking stretch — the parallel-
 * session navigation freeze). The log now keeps settled events verbatim plus
 * the LATEST update per in-flight message/tool call, replaced in place;
 * live update fan-out is coalesced to at most one frame per flush window
 * (latest wins — views replace by slot, and message_end carries the full
 * final message, so dropped intermediates are lossless). Replay therefore
 * costs the content once, never the chunk count.
 */
/** The wire event: a pi AgentEvent (with our slim message_update — see the
 * WIRE DIET note above), or one of the two app events. */
export type TurnWireEvent = AgentEvent | {
    type: "message_update";
    message: AgentMessage;
} | {
    type: "error";
    errorText: string;
};
export interface PiTurnSpec {
    /** The per-turn agent (stateless engine — built from the record). */
    agent: Agent;
    /** The handler's error-masking policy for LOOP-level failures (the
     *  event stream itself is verbatim — provider errors ride their
     *  message's stopReason/errorMessage through untouched). */
    onError?: (error: unknown) => string;
    /** The canonical end-of-turn seam: persist + usage + extraction + endTurn.
     *  Receives the agent's FULL final state (native messages) — the caller
     *  persists the slice past its own base count. */
    onFinish: (messages: AgentMessage[], isAborted: boolean) => void;
    /** Tool-call ids already used in this chat's record (THE LACAN FIX,
     *  owner-approved 2026-10-04): when present, a ToolCallIdUniquifier
     *  sits at this boundary — providers that reset ids every response
     *  (DeepSeek's `call_0` × every turn) get colliding ids reminted ONCE
     *  here, so wire views, the persisted record, the dock, answer
     *  routing, and the next turn's provider context all agree. Absent →
     *  verbatim passthrough (the protocol law below still holds). */
    usedToolCallIds?: ReadonlySet<string>;
    /** The coalescing window for update fan-out (COMPACTION LAW above).
     *  Defaults to 100ms; tests tighten it. */
    updateFlushMs?: number;
}
/** One view onto a running turn: push() replays/streams an event, done()
 *  terminates the view ([DONE] + close). Cheap to be a Set member. */
export interface PiTurnSubscriber {
    push(event: TurnWireEvent): void;
    done(): void;
}
/** The server-side turn object (background-turn runner wave, 2026-09-25):
 *  runs the agent decoupled from any single HTTP response and owns the
 *  in-memory event log + the live subscriber set. The POST response and
 *  the reattach stream are both subscribers onto it. */
export interface PiTurnHandle {
    /** A fresh subscriber stream: FULL replay of the log, then live events
     *  until the turn settles (ending [DONE]). Cancelling it detaches the
     *  view only — the turn runs on. */
    subscribe(): ReadableStream<Uint8Array>;
    /** The remote kill — the ONLY way a running turn dies early: sawAbort +
     *  agent.abort(); the loop's agent_end does the rest (the settle seam
     *  persists the partial transcript to every listener). */
    abort(): void;
}
export declare function runPiTurn(spec: PiTurnSpec): PiTurnHandle;
/** The subscriber-shaped SSE response — the POST /api/chat response and
 * GET /api/chats/[id]/stream are BOTH this: same headers, same wire
 * dialect, one protocol for the client to consume. */
export declare function piTurnResponse(handle: PiTurnHandle): Response;
//# sourceMappingURL=ui-stream.d.ts.map