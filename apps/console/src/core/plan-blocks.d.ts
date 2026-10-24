/**
 * Plan-block emission (docs/probe-teach-split.md §6): the INTERIM plan
 * presentation seam. The plan renders IN FLOW once, at authoring — a
 * frozen snapshot attached right after the assistant group carrying the
 * successful plan_init call. It is the presentation moment for the plan
 * (and the popup's entry point) — statuses on it are accurate at that
 * instant (current = null, everything upcoming — unless the authoring is
 * a mid-lesson rewrite, in which case the snapshot shows what was true
 * then).
 *
 * Wave B (owner-approved 2026-09-26): the block is a native plan-block
 * MARKER appended at the turn's persist (idempotent per plan_init call);
 * the projection splices its data part into the assistant group IN FLOW,
 * exactly where the UIMessage-era attach put it. The neighborhood-block
 * machinery stays retired: position derives live from the transcript.
 */
import type { PlanBlockData, PlanTree } from "./contracts.ts";
import type { LhMessage } from "./native-messages.ts";
/** The message part the chat renderer consumes (TeacherUIDataParts key
 *  "plan-block" — the SDK strips the `data-` prefix). Kept for the client
 *  renderers; the projection emits this shape. */
export interface PlanBlockPart {
    type: "data-plan-block";
    id: string;
    data: PlanBlockData;
}
/** The record's plan-block markers, keyed by the plan_init call they
 *  present — the idempotency set for emission. */
export declare function emittedPlanBlockCalls(messages: readonly LhMessage[]): Set<string>;
/**
 * The native emission seam (pure): ONE plan-block marker per TURN — for
 *  the turn's LAST successful plan_init call (a same-turn rewrite presents
 *  once; a later turn's rewrite gets its own block — the golden-master
 *  rule the UIMessage-era attach had) that the record hasn't already
 *  emitted. `tree` is the record's current tree (the plan tool saved it
 *  during the turn); `transcript` is the full NATIVE transcript the status
 *  derivation reads.
 */
export declare function planBlocksFor(record: readonly LhMessage[], newMessages: readonly LhMessage[], tree: PlanTree | null | undefined, transcript: readonly LhMessage[]): LhMessage[];
//# sourceMappingURL=plan-blocks.d.ts.map