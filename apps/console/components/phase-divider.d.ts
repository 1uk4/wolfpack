import type { Phase3 } from "@/src/core";
/** The header label: the phase as a quiet flat tag (owner,
 *  extraction-UX redesign 2026-09-24 — the UN-PILL round): no border, no
 *  pill chrome, no padding — the Plan chip is the only button-shaped thing
 *  in the top bar now. Still pure decoration (owner ask, 2026-09-17): no
 *  tooltip, not selectable, not interactive in any way — no pointer events
 *  at all, so it is part of the drag surface instead of a carved-out
 *  target. */
export declare function PhaseChip({ phase }: {
    phase: Phase3;
}): any;
/**
 * The transcript boundary: a monochrome dotted rule at the message where
 * the session enters `phase` (owner, minimal-color round — the label
 * carries the transition; the phase color never did). The plan seam
 * carries its node count ("Plan · 4 nodes"); teaching is just the label.
 * Null for probe (defensive — the fold never emits a probe transition
 * after the start).
 */
export declare function PhaseDivider({ phase, nodeCount }: {
    phase: Phase3;
    nodeCount?: number;
}): any;
/**
 * The node count for a plan seam: the first plan-op tree output in the
 * message that carries the seam (the plan_init that made the phase flip).
 * Structural slice of a UI message, same shape-of-shapes as core/phases.ts.
 */
export declare function planNodeCount(message: {
    parts: ReadonlyArray<{
        type: string;
        state?: string;
        output?: unknown;
        [k: string]: unknown;
    }>;
}): number | undefined;
//# sourceMappingURL=phase-divider.d.ts.map