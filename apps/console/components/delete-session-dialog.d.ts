import type { ChatDeleteMode, ChatListItem } from "@/src/core";
/** The graph-traces checkbox copy (owner, 2026-09-24 flow rework — was
 *  the delete-nodes option's body in the two-button design): the
 *  graph-touching consequence says so, shared-topic survival included.
 *  Exported pure for render pins: the copy is design, not implementation. */
export declare const TRACES_COPY: {
    testid: string;
    checkbox: string;
    title: string;
    body: string;
};
/**
 * Session deletion (wave 6 chunk A; owner flow rework 2026-09-24) — THE
 * destructive-confirmation surface, portaled z-50 like the setup dialog,
 * now in the node dialog's shape (the two must read as one design):
 *
 *   - red title "Delete session?" in the abort-turn look (owner, 2026-10-13
 *     polish: text-sm font-semibold JetBrains Mono via the UI default —
 *     the serif display title is gone), the session name below it in
 *     JetBrains Mono at normal text-sm size (was sized-up text-lg), no
 *     code-block chrome;
 *   - ONE unchecked-by-default checkbox "Also remove its graph traces"
 *     (unchecked = preserve-graph: the session record, its jobs, and its
 *     extraction bookkeeping die; the graph keeps every contribution.
 *     checked = delete-nodes: the session's ledger traces go too);
 *   - a bottom row Cancel + destructive-red Delete, exactly the node
 *     dialog's pair.
 *
 * Retryable failures render honestly with a Try-again: 409 turn_in_flight /
 * jobs_running ("wait for running work") and 503 extraction_winding_down
 * ("in a moment") both clear on their own — the server's error line is
 * already written for the user; we show it verbatim. Try-again is just
 * Delete pressed again — the mode re-derives from the checkbox.
 */
export declare function DeleteSessionDialog({ chat, onClose, onDeleted, }: {
    /** The session up for deletion; null = closed. */
    chat: Pick<ChatListItem, "id" | "title"> | null;
    onClose: () => void;
    /** Success path — the sidebar owns navigation + list patching. */
    onDeleted: (id: string, mode: ChatDeleteMode, graphRevision: number) => void;
}): any;
/** The dialog's pure body — exported for SSR pins (the settings-dialog /
 *  node-dialog body pattern). The wrapper owns state + effects + portal. */
export declare function DeleteSessionBody({ chat, traces, busy, failure, onTraces, onClose, onRun, }: {
    chat: Pick<ChatListItem, "id" | "title">;
    /** The graph-traces checkbox — unchecked by default (preserve-graph). */
    traces: boolean;
    busy: boolean;
    failure: {
        code: string;
        error: string;
    } | null;
    onTraces: (next: boolean) => void;
    onClose: () => void;
    onRun: () => void;
}): any;
//# sourceMappingURL=delete-session-dialog.d.ts.map