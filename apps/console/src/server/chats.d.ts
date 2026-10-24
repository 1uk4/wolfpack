import { type ChatDeleteMode, type ChatDeletionStats } from "../core/graph-deletion.ts";
import { titleFromPrompt } from "../core/contracts.ts";
/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the ChatStore port; the
 * services stage carves the real orchestration behind this same surface.
 *
 * deleteChatSession (wave 6, session deletion — the FIRST destructive
 * operation on the graph ledgers) is the one real orchestration here:
 * gates → extraction wind-down → one synchronous deletion block. See
 * core/graph-deletion.ts for the ledger semantics and the atomicity
 * argument.
 */
export declare const createChat: (title: string, kind?: "practice") => import("../core/contracts.ts").ChatRecord, getChat: (id: string) => import("../core/contracts.ts").ChatRecord | null, listChats: () => import("../core/contracts.ts").ChatSummary[];
export { titleFromPrompt };
export type { ChatDeleteMode, ChatDeletionStats } from "../core/graph-deletion.ts";
/** What deleteChatSession did — the route maps it straight to HTTP. */
export type ChatDeleteOutcome = {
    ok: false;
    status: 404;
    code: "not_found";
    error: string;
} | {
    ok: false;
    status: 409;
    code: "turn_in_flight" | "jobs_running";
    error: string;
    jobIds: string[];
} | {
    ok: false;
    status: 503;
    code: "extraction_winding_down";
    error: string;
} | {
    ok: true;
    mode: ChatDeleteMode;
    stats: ChatDeletionStats;
    jobsRemoved: number;
    graphRevision: number;
};
/**
 * Delete a session (owner rulings 2026-09-22/23): gates first, then the
 * purge. The owner-locked choreography:
 *
 *   1. GATES — a turn in flight or a running background job refuses with
 *      409 (they write the chat record and steer into it; deleting
 *      mid-flight would corrupt the write-ahead flow). The UI retries once
 *      work drains.
 *   2. EXTRACTION WIND-DOWN — the chat's own pipeline run is TRUE-
 *      CANCELLED (abortExtraction: spend stops, nothing merges), then
 *      awaited off the registry. A timeout is a retryable 503, never a
 *      forced race.
 *   3. THE SYNC BLOCK — everything below runs without a single await:
 *      no extraction append can interleave (the event loop never yields
 *      mid-block), so the read-filter-write of the ledger rewrites is
 *      atomic against the pipeline. Ledgers first, jobs next, the chat
 *      record LAST (a crash mid-block leaves a deletable chat with a
 *      purged graph — re-running DELETE fixes it — never a deleted chat
 *      with live traces). The pipeline's per-batch liveness guard
 *      (extraction.ts) closes the last window: a run that slipped past
 *      the wind-down finds the chat gone at its merge and aborts with
 *      nothing merged.
 */
export declare function deleteChatSession(chatId: string, mode: ChatDeleteMode): Promise<ChatDeleteOutcome>;
/** One session's coverage read (extraction-UX redesign, owner dispatch
 *  2026-09-24): the chat view's ring meter + popover data, scoped to one
 *  chat (the all-sessions GET died with this redesign — nothing consumed
 *  it once the sidebar and ring read here; the Extract POST stays).
 *  Uncovered stays DERIVED per request (fingerprint the transcript,
 *  diff the coverage ledger — never dual-tracked).
 *
 *  lastFoldedAt: the newest coverage row's fold timestamp — a cheap single
 *  pass over the chat's ledger rows (the ring popover's "last extraction"
 *  line); null before the session's first fold. */
export interface SessionCoverage {
    totalMessages: number;
    coveredCount: number;
    uncoveredCount: number;
    coveredTokens: number;
    uncoveredTokens: number;
    /** True while a chat-kind extraction run is registered for this session. */
    running: boolean;
    /** ISO of the newest fold in this session's coverage rows; null before any. */
    lastFoldedAt: string | null;
}
/** The per-session coverage block (see SessionCoverage). Null when the
 *  chat doesn't exist — callers own the 404. */
export declare function sessionCoverage(chatId: string): SessionCoverage | null;
//# sourceMappingURL=chats.d.ts.map