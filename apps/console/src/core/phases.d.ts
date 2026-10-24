/**
 * Phase derivation (docs/probe-teach-split.md §4) — EXPLICIT EVENTS, never
 * occupancy. The probe→teach agent split (2026-09-11) gave the first
 * boundary a transcript event; the second is INFERRED (owner ruling
 * 2026-09-26, the verdict death):
 *
 *   probe  — until the prober's `probe_done` call CONCLUDES (a clean
 *            toolResult for it; the assessment rides the call's arguments)
 *   plan   — probe concluded, until teaching actually BEGINS
 *   teach  — the first quiz tool call tagged with a `nodeId` (a question
 *            ABOUT a plan node — probe quizzes carry no nodeId in their
 *            schema, so nothing false-triggers). The CALL is the seam, not
 *            its answer: the block that poses the first node question is
 *            where teaching starts.
 *
 * There is no verdict gate anymore: presenting the plan ends the teacher's
 * turn, and the learner's next message is a natural reply (a change
 * request, or the go-ahead). The live indicator LAGS by design (owner
 * accepted): "teach" shows only once the first node's question is posed.
 * A teacher that never tags a quiz can no longer exist — nodeId is
 * schema-required at the teach quiz boundary (owner ruling 2026-09-26),
 * so the seam signal is structural, not prompt-mandated.
 *
 * The former derived-occupancy seam (phase-of-tree via `currentNodeId`)
 * is GONE, as is the verdict-marker fold: no backwards compatibility
 * (legacy sessions are wiped data).
 *
 * TWO FOLDS over the same events (Wave D): `phaseAt3`/`phaseTimeline` fold
 * VIEW messages (the client's dividers and dock — part shapes, pure and
 * structural); `phaseAt3Lh` folds the NATIVE record (server summaries,
 * tests) — probe→plan advances at the probe_done RESULT message, plan→teach
 * at the assistant message carrying the first nodeId-tagged quiz CALL.
 * Both are strictly sequential; the two derivations agree on every settled
 * record (a call's part projects into the same view boundary).
 *
 * Pure: no imports, no runtime deps — safe on server, client, and tests.
 */
/** The three phases of a session, as the picker / header / dividers see them. */
export type Phase3 = "probe" | "plan" | "teach";
/**
 * Minimal structural slice of a UI message for the phase scan: parts with
 * a state, an input (a tool call's parsed arguments), and (for concluded
 * calls) an output.
 */
export interface PhaseMessage {
    parts: ReadonlyArray<{
        type: string;
        state?: string;
        input?: unknown;
        output?: unknown;
    }>;
}
/** The phase at `upToIndex` (inclusive; default: the last message). */
export declare function phaseAt3(messages: readonly PhaseMessage[], upToIndex?: number): Phase3;
/**
 * WHERE inside the flipping message teaching begins (owner round 8,
 * 2026-10-05 — the stacked-dividers bug): plan→teach flips at the first
 * tagged quiz/explain CALL, but the plan PRESENTATION often lives in the
 * same assistant message — an earlier provider STEP than the quiz call.
 * A message-level seam therefore drew the Teaching divider before the
 * plan presentation too (Planning and Teaching stacked back-to-back).
 * This returns the part index of the STEP BOUNDARY governing the flip
 * call: -1 when the call sits in the message's FIRST step (the divider
 * belongs before the whole message), else the index of the step-start
 * part whose generation contains the call — the divider renders there,
 * between the plan presentation and the teaching block.
 */
export declare function teachStepIndex(parts: ReadonlyArray<{
    type: string;
    state?: string;
    input?: unknown;
}>): number;
/**
 * The phase at EVERY message index, in one forward fold — the transcript
 * dividers render one per boundary, so phaseAt3(m, i) per index would rescan
 * 0..i each time (quadratic); this is the same derivation, linear.
 * out[i] === phaseAt3(messages, i) for every i.
 */
export declare function phaseTimeline(messages: readonly PhaseMessage[]): Phase3[];
import type { LhMessage } from "./native-messages.ts";
/** The phase at `upToIndex` (inclusive; default: the last message) of a
 *  NATIVE record. probe→plan advances at the probe_done call's clean
 *  toolResult; plan→teach at the assistant message carrying the first
 *  nodeId-tagged quiz CALL (mirrors the view fold — same seam, native
 *  shape). */
export declare function phaseAt3Lh(messages: readonly LhMessage[], upToIndex?: number): Phase3;
//# sourceMappingURL=phases.d.ts.map