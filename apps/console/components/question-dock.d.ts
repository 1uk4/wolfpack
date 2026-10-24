import { type AskToolInput, type ExplainToolInput, type QuestionAnswerData, type QuizToolInput, type Phase3 } from "@/src/core";
/**
 * The question dock — a pending quiz/ask REPLACES the chat composer: the
 * persistent bottom blob morphs into the question. Two voices meet here:
 * the teacher's (question, options, explanation) and the learner's —
 * "Your thinking", a labeled composer-twin field for dumping reasoning,
 * with Submit docked inside it exactly like the chat composer's send.
 *
 * The thinking field is the transfer channel of the whole product (wave-2):
 * never called "optional", Enter makes a NEWLINE (it is for dumping — soon
 * dictated, not typed), submission is the button only, and its size scales
 * with the phase (probing stays quick; teaching invites depth). The
 * "Other…" option is an editable option ROW — circle + inline input,
 * styled like its siblings — so picking Other never displaces thinking.
 *
 * Collapse behavior (scroll-up → slim bar) is owned by the DockOverlay in the
 * chat view, which also owns the persistent shell and its height morph. This
 * component is content only. The expanded form stays MOUNTED while collapsed
 * (hidden, not unmounted) so a half-made selection survives scrolling.
 */
export interface QuestionDockProps {
    toolName: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
    toolCallId: string;
    input: QuizToolInput | AskToolInput | ExplainToolInput;
    /** Collapse state, owned by the DockOverlay (it drives the shell's height morph). */
    expanded: boolean;
    /**
     * Teach-phase check awaiting its reveal (vision §2, W5): while collapsed,
     * the bar is the "Check your understanding" invitation instead of the
     * scroll-collapse strip. Owned by the DockOverlay; false once the learner
     * has revealed (afterwards the normal collapse machine rules apply).
     */
    reveal?: boolean;
    onExpand: () => void;
    onSubmit: (output: QuestionAnswerData) => void;
    /** Escape in a question field stops dictation (STT wave) — threaded
     *  from the page that owns the dictation hook. */
    onEscape?: () => void;
    /** The keyboard machine (wave B) is armed only while the dock is
     *  expanded — the collapsed bar keeps its native Enter-to-expand. */
    active?: boolean;
    /** Session phase at the question — scales the thinking field: probing
     *  stays quick (one row), teaching invites dumping (three rows). */
    phase?: Phase3;
    /** Dictation claim (owner 2026-10-03): false while a teach-phase check
     *  sits UNREVEALED — the reading-thinking field owns dictated speech
     *  during the reading; the dock reclaims on reveal. Default true (probe
     *  questions, predictions, old callers). */
    dictationClaim?: boolean;
    /** Compaction is running for this chat (owner round 14): the answer
     *  POST would block on the server's compaction gate — disable submit
     *  and say so in the hint row. The server registry is the real gate;
     *  this is the affordance. */
    compactionRunning?: boolean;
}
export declare function QuestionDock({ toolName, toolCallId, input, expanded, reveal, onExpand, onSubmit, onEscape, phase, dictationClaim, compactionRunning, }: QuestionDockProps): any;
/** The collapsed strip. Two species (W5): "collapsed" is the scroll minimization
 *  (kind chip + one-liner + Answer ↓); "reveal" is the teach-check invitation —
 *  a distinct, more inviting affordance, because it asks the learner to start
 *  something, not to resume something. */
export declare function QuestionDockBar({ toolName, question, onExpand, variant, label, toolLabel, }: {
    toolName: "quiz" | "ask_user_question" | "explain";
    question: string;
    onExpand: () => void;
    variant?: "collapsed" | "reveal";
    /** The kind chip's text (owner 2026-10-03): "Prediction" when a
     *  predict-type quiz minimizes by scroll — predictions never use the
     *  reveal variant, but the scroll-collapse strip can still hide them. */
    label?: string;
    /** The chip's TOOL display name (owner 2026-10-09): probe-phase calls
     *  label Probe/Recall — the phase boundary visible in the composer. */
    toolLabel?: string;
}): any;
//# sourceMappingURL=question-dock.d.ts.map