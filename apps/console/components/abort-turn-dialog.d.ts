/**
 * The ESC-abort guard (owner, 2026-10-02): the global Esc → abort chain
 * opens this confirm popup EVERYWHERE — mid-stream aborts and pending-
 * question dismissals alike. Esc on the popup itself cancels (claimed —
 * it must never chain into another abort), which is also why Chat's
 * abort handler ignores events while this dialog is open: two window
 * listeners fire per Esc and stopPropagation alone cannot order them.
 *
 * MINIMAL, the delete-node dialog's tone: title, one line, Cancel +
 * action. No busy state — both actions are local (a fetch that fires
 * and forgets, an answer submit whose own machinery shows progress).
 *
 * What "abort" means is mode-dependent: from a running turn it kills
 * the turn (partial stays); from a pending question there is no turn to
 * kill — abort IS dismissal (A2, 2026-10-03): the silent route writes
 * the skipped toolResult and wakes NOTHING; the session pauses until
 * the user's next plain message, which carries the dismissal to the
 * model in its context.
 */
/** What Esc is aborting — drives copy and the confirm action. */
export type AbortMode = "turn" | "question" | "problem";
/** The dialog's pure body — exported for SSR pins (the delete-node
 * pattern). The wrapper owns effects + the portal. */
export declare function AbortTurnBody({ mode, onClose, onConfirm, busy, }: {
    mode: AbortMode;
    onClose: () => void;
    onConfirm: () => void;
    /** The dismiss doubles as the abort when a turn is still running
     * (owner, 2026-10-04): the line says so. */
    busy?: boolean;
}): any;
export declare function AbortTurnDialog({ mode, onClose, onConfirm, busy, }: {
    /** What Esc is aborting; null = closed (nothing rendered). */
    mode: AbortMode | null;
    onClose: () => void;
    onConfirm: (mode: AbortMode) => void;
    busy?: boolean;
}): any;
//# sourceMappingURL=abort-turn-dialog.d.ts.map