/**
 * The probe conclusion card (docs/probe-teach-split.md §2): renders the
 * prober's probe_done call. The INPUT is the learner assessment — strand by
 * strand, where his edge sits — and it belongs to the learner as much as to
 * the transcript: it streams live while the prober writes it and stays as
 * the handoff artifact. The OUTPUT is the seam's ack (ok) or the refusal
 * the prober retried on (rendered quiet and small — it is model-facing
 * bookkeeping, kept only for transcript honesty).
 *
 * The input preview is only trustworthy while the call is pending — an
 * input-available input cleared schema validation at the boundary, and a
 * mid-stream partial is guarded below. An output-error part's input was
 * REJECTED by validation and can be any shape (live crash: the model
 * stringified `assessment`); never render it.
 *
 * Deliberately plain v1: the proper assessment viewer design is deferred to
 * the UI wave; this card just guarantees the data is never invisible.
 */
export declare function ProbeDoneCard({ part }: {
    part: {
        input?: unknown;
        output?: unknown;
        state?: unknown;
    };
}): any;
//# sourceMappingURL=probe-done-card.d.ts.map