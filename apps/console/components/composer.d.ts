/**
 * The chat composer — content row ONLY (the persistent rounded shell lives in
 * the chat view's overlay, so the shell can later morph chat → question
 * without remounting).
 *
 * Corner-radius math (concentric with the shell): shell rounded-2xl (16px) −
 * row padding p-1.5 (6px) = button rounded-[10px] = 25% of the 40px button.
 */
/** What one Enter press does, in precedence order: stop a busy stream,
 *  otherwise send the message, otherwise — practice sessions only — fire
 *  the next-problem signal while the between-problems pause is live
 *  (owner round 16: Enter on an EMPTY composer is the go-ahead; typing
 *  anything makes Enter a send again). Pure so the static-render harness
 *  can pin the decision (key events can't be simulated in
 *  renderToStaticMarkup). */
export declare function enterAction(state: {
    busy: boolean;
    canSend: boolean;
    /** The between-problems pause is live: practice session, nothing
     *  active, no turn/compaction in flight (the caller's fold). */
    nextProblem?: boolean;
}): "stop" | "send" | "next" | "none";
export declare function Composer({ busy, value, onChange, onSend, onStop, canSend, autoFocus, inputRef, onEscape, placeholder, nextProblem, onNext, }: {
    busy: boolean;
    value: string;
    onChange: (v: string) => void;
    onSend: () => void;
    onStop: () => void;
    canSend: boolean;
    autoFocus?: boolean;
    /** The page's handle to the textarea — the dictation-end focus (owner,
     *  2026-10-01): a run ending hands the cursor to the bare composer. */
    inputRef?: React.RefObject<HTMLTextAreaElement | null>;
    /** Escape while a dictation runs stops it (STT wave, 2026-09-17). No-op
     *  when absent — Esc otherwise means nothing in the composer. */
    onEscape?: () => void;
    /** The textarea's placeholder (owner refinement round, 2026-09-24):
     *  active sessions read "Ask, answer, or steer the lesson…"; the fresh
     *  new-session page asks the graph view's opening question instead. */
    placeholder?: string;
    /** The practice pause is live (owner round 16): Enter on the empty
     *  composer fires the next-problem signal instead of doing nothing —
     *  the keyboard-first move-on. */
    nextProblem?: boolean;
    /** The signal's dispatcher (send({type:"next"})) — the chip and the
     *  empty-Enter share it. */
    onNext?: () => void;
}): any;
//# sourceMappingURL=composer.d.ts.map