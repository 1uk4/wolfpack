/**
 * THE SESSION MODEL (Wave D): the chat session's state machine, extracted
 * PURE — no React, one injectable fetch — so the attach/replay/settle/
 * error/abort paths are testable in the repo's node:test world. The React
 * hook (components/session.ts) is a thin adapter: it re-renders on change
 * and projects the view (core/view.ts).
 *
 * ONE VIEW PROTOCOL: every turn is a server-side background process (owner
 * ruling 2026-09-25); this model is a view. Sends POST one explicit input
 * event ({chatId, input}); the response and the reattach stream
 * (GET /api/chats/[id]/stream) are the SAME verbatim AgentEvent SSE,
 * applied by the same function. Status vocabulary (pre-Wave-D parity):
 * ready | submitted | streaming | error.
 */
import { type ChatInput, type LhMessage, type LhViewMessage, type QuestionAnswerData } from "../src/core";
export type SessionStatus = "ready" | "submitted" | "streaming" | "error";
/** How often to poll turnInFlight while a racing turn runs (409 retry). */
export declare const TURN_POLL_MS = 500;
/** Give up waiting (a wake turn can run long) and surface the 409. */
export declare const TURN_WAIT_MAX_MS = 30000;
export interface SessionModelDeps {
    /** Injectable fetch (tests); defaults to the global. */
    fetch?: typeof globalThis.fetch;
    /** Injectable retry timing (tests). */
    pollMs?: number;
    waitMaxMs?: number;
}
/** The dangling question call's tool name (the optimistic answer result's
 *  toolName — the server stamps the same from its own record scan). */
export declare function pendingCallTool(messages: readonly LhMessage[], toolCallId: string): string | null;
/**
 * Has the record ABSORBED this optimistic tail entry? The write-ahead
 * persists content-identical copies with server-stamped ids — match on the
 * content, not the (local) id; only `c_`-prefixed local entries are ever
 * absorbed (live turn content is never dropped).
 */
export declare function absorbed(m: LhMessage, record: readonly LhMessage[]): boolean;
export interface SessionState {
    messages: LhViewMessage[];
    nativeMessages: LhMessage[];
    status: SessionStatus;
    error: {
        message: string;
    } | null;
    /** Steers sent but not yet drained (composer steering, 2026-10-03):
     *  the queued indicator's truth. An entry dies when its id lands in
     *  the messages (the drain's verbatim events upsert the real card) —
     *  visibleQueuedSteers is the pure fold. */
    steerQueue: SteerQueueItem[];
}
/** One queued composer steer: the client-minted id (the upsert key) + text. */
export interface SteerQueueItem {
    id: string;
    text: string;
}
/** The indicator's fold (pure): a queued steer stays visible until its id
 *  lands in the message list — from the live stream's upsert, the settle
 *  sync, or a reload. A steer parked server-side (stranded behind a
 *  question) keeps its line: honest "waiting" until the next run drains it. */
export declare function visibleQueuedSteers(queue: readonly SteerQueueItem[], messages: readonly LhMessage[]): SteerQueueItem[];
export interface SessionModelOptions extends SessionModelDeps {
    chatId: string;
    initialMessages: LhMessage[];
    /** Fires on every state change (the hook re-renders). */
    onChange?: () => void;
    /** The reattach settled terminal (turn-settled): no turn running, the
     *  record is current — the caller refetches it. */
    onReattachSettled?: () => void;
}
export declare class SessionModel {
    readonly chatId: string;
    /** Injectable fetch (tests); defaults to the global. */
    fetch: typeof globalThis.fetch;
    /** Steers sent but not yet drained (the queued indicator's truth). */
    private steerQueueValue;
    private readonly pollMs;
    private readonly waitMaxMs;
    private onReattachSettled?;
    /** The hook's re-render trigger (set by the adapter). */
    onChange?: () => void;
    private base;
    private tail;
    private executions;
    private streamingIds;
    /** The in-flight assistant message's client id (see applyWireEvent). */
    private streamingMessageId;
    private statusValue;
    private errorValue;
    private consumeAbort;
    /** Synchronous ready check for the gate (send/read mount logic). */
    readyRef: boolean;
    constructor(opts: SessionModelOptions);
    /** Injectable settle hook (the adapter wires its ref). */
    setReattachSettled(fn: () => void): void;
    getState(): SessionState;
    get status(): SessionStatus;
    /** Mutate model state + notify (the hook re-renders). */
    private mutate;
    private setStatus;
    private setError;
    /** The 409 identity-retry fetch (the Wave B contract): the event was
     *  never persisted (write-ahead happens only on acceptance), so the
     *  retry waits out the running turn and re-POSTs the SAME body. */
    postInputEvent(input: ChatInput, signal?: AbortSignal): Promise<Response>;
    /**
     * ONE event application for both the POST stream and the reattach
     * replay (pi's events carry the FULL partial message — a view REPLACES,
     * never assembles deltas). Returns whether the event did VIEW WORK:
     * the consume flips submitted→streaming on the first ACTED event, not
     * the first wire byte — agent_start/turn_start release nothing, so
     * the Thinking… placeholder (gated on submitted) covers the whole
     * provider-connect gap (owner, optimistic round 3, 2026-10-02).
     */
    applyWireEvent(event: Record<string, unknown>): boolean;
    /** Consume one SSE body to its [DONE] terminal. The turn-settled
     *  terminal (stream-route only) fires the settle hook and ends. */
    consumeStream(res: Response): Promise<void>;
    /**
     * Reattach (the wake/handoff/mount path): a server-side turn with no
     * live view of ours. ATTACH-FIRST (owner, reattach round 2026-10-02):
     * a fresh-mount reattach passes refetchRecordFirst=false — the page
     * render just read the record, so the blocking record round-trip only
     * added handshake latency before the instant replay; the running
     * turn's partial lives solely in the server event log, and the replay
     * rebuilds it regardless of the refetch. Mid-session callers (the
     * handoff watch) keep the default: their base may trail the record,
     * and the refetch absorbs it (write-ahead adoption) before the replay
     * lands on top. The stream then replays the turn from its first event
     * through the SAME consume path.
     */
    resumeStream(refetchRecordFirst?: boolean): Promise<void>;
    /**
     * SEND: one explicit input event. Optimistic appends first (the instant
     * answer/note UX — the server's write-ahead persists the canon), then
     * POST + consume. Ready-gated: one turn per client at a time (the
     * server's 409 + identity retry covers the wake-race window).
     */
    send(input: ChatInput): Promise<void>;
    /**
     *  STEER (composer steering, owner arc 2026-10-03): the learner's
     *  mid-turn message for the RUNNING turn. NOT a turn — no optimistic
     *  transcript card, no status flip: the message joins the queued
     *  indicator (the quiet line above the composer) and POSTs to the
     *  steer route, which hands it to the live agent's steering queue.
     *  When pi drains it at the next response boundary, the verbatim
     *  message events upsert the real card (the client-minted id is the
     *  key) and the indicator's fold drops the line. A 409 means the turn
     *  settled mid-send (the race): fall back to the plain text send —
     *  the entry is dropped and send() pushes its own optimistic card.
     */
    steer(text: string): Promise<void>;
    /** The answer path (the dock): the answer IS the question call's tool
     *  result (fork 1), riding as its input event. */
    submitAnswer(tool: string, toolCallId: string, output: QuestionAnswerData): Promise<void>;
    /** The dismissal path (owner design 2026-10-03, "A2"): the skipped
     * toolResult lands optimistically, then the SILENT route persists it
     * — no turn, no stream, nothing wakes. The session pauses at the
     * user's choice; the next plain send is the wake. On failure the
     * durable record wins: the error surfaces, the record-changed sync
     * (or any later refetch) replaces the optimistic append with truth. */
    dismissQuestion(toolCallId: string, answer: QuestionAnswerData): Promise<void>;
    /** The problem discard (practice sessions, owner 2026-10-04): the
     *  ask-style dismissal — the UI-only marker lands optimistically, then
     *  the SILENT route persists it (no turn, no wake). The composer
     *  returns; the conclude synthesis rides the user's next input. */
    dismissProblem(problemCallId: string): Promise<void>;
    /** Local detach: cancel the consume, keep the partial tail. The page's
     *  settle watch adopts the record when the server turn finishes. */
    stop(): void;
    /** Full snapshot swap (the idle settle sync — server canon). */
    setMessages(record: LhMessage[]): void;
    /**
     * Append-only adoption (the mid-turn steer/artifact ground rule): swap
     * in the record — every current base message must still be present
     * (the server appends only) — keeping the live tail, minus the
     * optimistic entries the record has absorbed (their server-stamped
     * copies just landed; without this the input bubble would double).
     */
    adoptRecord(record: LhMessage[]): void;
    /** The mount/sync continuation fold (native-messages.ts). */
    static needsContinuation: any;
    clearError(): void;
}
//# sourceMappingURL=session-core.d.ts.map