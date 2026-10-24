/**
 * The practice dock (practice sessions, owner design 2026-10-04): an
 * ACTIVE problem replaces the chat composer — the persistent bottom blob
 * morphs into the problem. The agent's statement above; the learner's
 * half below — "Your thinking", a labeled field with ONE Send button
 * (owner round 2, 2026-10-05): Enter sends, Shift+Enter makes a newline.
 * There are no lanes — whether a submission claims an answer is apparent
 * from the thinking itself; the agent reads it. One problem may carry
 * many submissions; each starts a turn.
 *
 * Collapse (scroll-up → slim bar) is owned by the DockOverlay; this
 * component is content only, and the expanded form stays MOUNTED while
 * collapsed (hidden) so a half-written trace survives scrolling.
 *
 * The commitment (modelSolution, decisionPoints, …) rides the tool call's
 * arguments and is NOT rendered here — only the statement is the
 * learner's. Esc dismisses the problem (the layered-Esc chain; the
 * confirm dialog then the silent route) — claimed by the page, not here.
 */
export interface PracticeDockProps {
    /** The active problem's tool-call id (submissions target it). */
    problemCallId: string;
    /** The pose's arguments — only the statement is the learner's (the
     *  mode badge would edge toward announcing the target; dropped). */
    input: {
        statement: string;
    };
    /** Collapse state, owned by the DockOverlay. */
    expanded: boolean;
    onExpand: () => void;
    /** text — POST {type:"thinking"} (one lane; the register is read from the text). */
    onSubmit: (text: string) => void;
    /** Escape in the thinking field stops dictation (threaded from the page). */
    onEscape?: () => void;
    /** Compaction is running for this chat (owner round 14): the thinking
     *  POST would block on the server's compaction gate — disable submit
     *  and say so in the hint row. The server registry is the real gate;
     *  this is the affordance. */
    compactionRunning?: boolean;
}
export declare function PracticeDock({ problemCallId, input, expanded, onExpand, onSubmit, onEscape, compactionRunning }: PracticeDockProps): any;
//# sourceMappingURL=practice-dock.d.ts.map