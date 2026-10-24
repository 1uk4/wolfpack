import type { CSSProperties } from "react";
/**
 * The confidence RAIL — the slider's paint, shared by two surfaces so they
 * can never drift apart (owner, 2026-10-01):
 *
 *   - the dock's live slider (question-dock) — a transparent range input
 *     rides on top of this paint, disc and all;
 *   - the ANSWERED card (owner round 6) — the same rail with NO disc,
 *     which itself communicates "this is a record, not a control".
 *
 * Geometry law: the rail spans the thumb-CENTER range (inset half a 16px
 * disc per side) so the dock's 0/100 stops sit flush at the very ends.
 * The static card has no thumb, but keeps the identical shape.
 *
 * Stack law: #141414 base (the darker main background), SOLID stop ticks
 * as background layers UNDER the fill, and the fill itself TRANSPARENT
 * past the value — so ticks show only on the empty side, never over the
 * color. Ticks skip 0 and 100 (the rail's ends already say those).
 */
/** The six-step ramp (owner ruling): 0 red → 100 emerald, indexed by stop. */
export declare const CONFIDENCE_COLORS: readonly string[];
/** The rail's paint for a stop value (0–100). */
export declare function confidenceRailStyle(value: number): CSSProperties;
/** The static rail — the slider's look, disc removed. */
export declare function ConfidenceRail({ value, className }: {
    value: number;
    className?: string;
}): any;
//# sourceMappingURL=confidence-rail.d.ts.map