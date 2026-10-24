/**
 * The reading-thinking field (owner design 2026-10-03, "two questions per
 * teaching unit"): a quiet textarea for thinking WHILE READING the
 * teaching prose — the same transfer channel the question dock's "Your
 * thinking" gives the answer, opened one phase earlier. It mounts while a
 * teach-phase check waits behind its reveal (the same cue that collapses
 * the check), rides the check answer as the SEPARATE `readingThinking`
 * channel (never conflated with the quiz thinking), and disappears with
 * the question.
 *
 * Dictation: while the check sits UNREVEALED this field is the primary
 * target (the dock releases its claim — dictated reading-thoughts land
 * here, not in the hidden quiz field); once the learner reveals the
 * check, the dock reclaims and this field is plain typing.
 */
export declare function ReadingThinkingField({ value, onChange, onEscape, onOpen, claim, }: {
    value: string;
    onChange: (v: string) => void;
    /** Esc in the field stops dictation (threaded from the page's hook). */
    onEscape?: () => void;
    /** The check waits CLOSED — Enter opens it (owner, keyboard round
     *  2026-10-06). The caller finishes any live dictation FIRST (the
     *  flush lands here — the field is the live claim), then reveals.
     *  Absent = the check is open: Enter keeps the dumping convention. */
    onOpen?: () => void;
    /** Primary dictation claim — true while the check is behind its reveal. */
    claim: boolean;
}): any;
//# sourceMappingURL=reading-thinking.d.ts.map