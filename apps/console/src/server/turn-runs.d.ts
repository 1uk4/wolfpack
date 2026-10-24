/**
 * The running-turn registry (background-turn runner wave, owner ruling
 * 2026-09-25): chatId → the live PiTurnHandle. THE reattach surface —
 * GET /api/chats/[id]/stream resolves here, and the remote abort
 * (/api/activity/abort, kind "turn") kills through here.
 *
 * Same globalThis discipline as turn-liveness.ts (read its header): Next
 * dev compiles each route as its own module instance, so a module-level
 * Map would be a DIFFERENT registry in the POST /api/chat entry and the
 * GET .../stream entry. globalThis spans module instances within the
 * process.
 *
 * Registration lifecycle: chat-handler registers the handle the moment
 * the turn starts (after the 409 guard) and its onFinish unregisters LAST
 * — after persist, usage, extraction, and endTurn — so anything that sees
 * "no running turn" also sees an already-persisted record. The per-chat
 * 409 guard means a chatId can hold at most one handle, and beginTurn's
 * 30-minute TTL bounds the pathological never-settling case the same way
 * it does for the liveness map: if onFinish never fires, the stale entry
 * is overwritten by the next turn's registration (Map.set) and garbage
 * collected — no unbounded leak beyond the same pathology turn-liveness
 * already accepts.
 *
 * App-quit mid-turn (the process dying with an un-persisted turn) is the
 * SAME residual as before the wave: the registry is memory-only, the
 * write-ahead record + liveness TTL recovery cover the next mount.
 */
import type { PiTurnHandle } from "./pi/ui-stream.ts";
/** Register the chat's running turn (chat-handler, right after the turn
 *  starts). One per chat by construction — the 409 guard. */
export declare function registerTurn(chatId: string, handle: PiTurnHandle): void;
/** Unregister at settle — chat-handler's onFinish, LAST (after endTurn). */
export declare function unregisterTurn(chatId: string): void;
/** The live turn handle for a chat, or undefined — the subscribe endpoint's
 *  and the abort channel's resolution point. */
export declare function runningTurn(chatId: string): PiTurnHandle | undefined;
/** The remote kill: any client (original sender, reattached viewer, future
 *  surfaces) may stop a running turn. not_running mirrors abortJob's
 *  honest 409 — there was nothing to abort, the caller refetches. */
export declare function abortTurn(chatId: string): {
    ok: true;
} | {
    ok: false;
    reason: "not_running";
};
/** The cheap terminal when GET /api/chats/[id]/stream finds no running
 *  turn (raced settle, or the client checked turnInFlight a beat too
 *  late): a same-dialect SSE response whose single chunk tells the client
 *  "nothing to attach to — the record is current, refetch it". Chosen as
 *  an EVENT (not a status code) so the reattach path consumes ONE wire
 *  protocol end to end. */
export declare function settledTurnResponse(): Response;
//# sourceMappingURL=turn-runs.d.ts.map