/**
 * Graph render settings: the shape, the defaults, the sanitizer, and the
 * slider mapping (log-scaled, default-centered) — shared by the client (components/graph-canvas.ts,
 * graph-view.tsx), the server store (src/store/render-settings.ts, which
 * persists them to data/render-settings.json), and the API route.
 *
 * This module is pure: no DOM, no d3, no node APIs — safe everywhere.
 *
 * Settings are server-persisted (render-settings.json); the localStorage era
 * is over. Whatever arrives from disk or the network is passed through
 * sanitizeRenderSettings before use — never trusted raw.
 *
 * SIZE SEMANTICS (2026-09-15 pivot): nodeSize, labelSize, arrowLength and
 * regions.dilation are WORLD UNITS — the same law as the physics spacings.
 * The world scale is canonical: identical settings render identically at
 * any graph size, at any zoom. (They were "screen px at fit zoom" before,
 * which made node sizes a function of graph extent — the small-graph bug.)
 *
 * The labelZoom semantics: the sigma-compatible "camera ratio" threshold
 * (1 = fit zoom, SMALLER = zoomed in). Node labels show at ratio <= labelZoom
 * and cross-fade with the cluster labels across a span proportional to the
 * gate (see LABELS_FADE_RATIO in the renderer). Persisted values keep these
 * units across the renderer swap.
 *
 * SLIDER LADDERS (2026-09-17, user-directed): every NON-physics knob moves on
 * a hand-authored 11-stop ladder — the classic two-per-octave nice-number
 * series (x1.5 / x1.33 alternation: ...1, 1.5, 2, 3, 4, 6, 8, 12...) — with
 * the DEFAULT dead-center at position 50 (slider step 10, one stop per
 * detent). No more log-slider artifacts like 2.18137...977: a knob's possible
 * values ARE the ladder, the sanitizer snaps any incoming value to the
 * nearest entry, and out-of-range snaps to the end. Physics keeps the
 * fine-grained log sliders (user: "very fine tunable... good as they are").
 */
import { CHARGE_STRENGTH, CLUSTER_PULL_STRENGTH, INCREMENTAL_GRAVITY, LINK_DISTANCE, } from "./layout.ts";
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
/**
 * Coerce arbitrary JSON (server file, network body, localStorage leftovers)
 * into valid settings: missing keys fall back to defaults, out-of-range
 * values clamp, wrong types reset. Never throws.
 */
export function sanitizeRenderSettings(raw) {
    const r = (raw ?? {});
    // Ladder knob: any finite value snaps to the nearest ladder entry (ties
    // break low); non-numbers fall back to the default (dead-center anyway).
    const ladd = (v, ladder, dflt) => typeof v === "number" && Number.isFinite(v) ? snapToLadder(v, ladder) : dflt;
    // The size-unit pivot (2026-09-15): pre-"world" files stored sizes in
    // "screen px at fit zoom" — a unit whose meaning depended on the
    // graph's own extent (THE small-graph bug). Those values cannot be
    // carried into world units honestly, so they reset to defaults; the
    // reference default IS the old tuned look expressed in world units.
    const legacySizes = r.sizeUnits !== "world";
    return {
        sizeUnits: "world",
        nodeSize: legacySizes ? DEFAULT_RENDER_SETTINGS.nodeSize : ladd(r.nodeSize, NODE_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.nodeSize),
        edgeWidth: ladd(r.edgeWidth, EDGE_WIDTH_LADDER, DEFAULT_RENDER_SETTINGS.edgeWidth),
        arrowLength: legacySizes ? DEFAULT_RENDER_SETTINGS.arrowLength : ladd(r.arrowLength, ARROW_LENGTH_LADDER, DEFAULT_RENDER_SETTINGS.arrowLength),
        labelZoom: ladd(r.labelZoom, LABEL_ZOOM_LADDER, DEFAULT_RENDER_SETTINGS.labelZoom),
        labelSize: legacySizes ? DEFAULT_RENDER_SETTINGS.labelSize : ladd(r.labelSize, LABEL_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.labelSize),
        clusterLabels: typeof r.clusterLabels === "boolean" ? r.clusterLabels : DEFAULT_RENDER_SETTINGS.clusterLabels,
        clusterLabelSize: ladd(r.clusterLabelSize, CLUSTER_LABEL_SIZE_LADDER, DEFAULT_RENDER_SETTINGS.clusterLabelSize),
        // Nested sections (2026-09-13): old files lack them → defaults.
        // Legacy files also reset regions.dilation (its units changed with
        // the pivot); the rest of the section's semantics are untouched.
        regions: legacySizes
            ? { ...sanitizeRegionTuning(r.regions), dilation: DEFAULT_REGION_TUNING.dilation }
            : sanitizeRegionTuning(r.regions),
        physics: sanitizePhysicsTuning(r.physics),
    };
}
export const REGION_BITMAP_OPTIONS = [128, 192, 256, 384, 512];
export const DEFAULT_REGION_TUNING = {
    dilation: 20,
    // New default 40 (owner, 2026-10-07): softer, wider region tints.
    blur: 40,
    bitmap: 256,
    edgeAlpha: 0.2,
    enabled: true,
};
/** Nearest member of a fixed option set (dropdowns have no free values). */
function snapToOption(value, options) {
    return options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) ? o : best), options[0]);
}
/** Clamp/validate a region tuning. `bitmap` snaps to the nearest allowed
 *  option (a fixed set — dropdown, not a free number). */
export function sanitizeRegionTuning(input) {
    const d = DEFAULT_REGION_TUNING;
    const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
    const bitmap = num(input?.bitmap, d.bitmap);
    const ladd = (v, ladder, dflt) => typeof v === "number" && Number.isFinite(v) ? snapToLadder(v, ladder) : dflt;
    return {
        dilation: ladd(input?.dilation, REGION_DILATION_LADDER, d.dilation),
        blur: ladd(input?.blur, REGION_BLUR_LADDER, d.blur),
        bitmap: snapToOption(bitmap, REGION_BITMAP_OPTIONS),
        edgeAlpha: ladd(input?.edgeAlpha, REGION_EDGE_ALPHA_LADDER, d.edgeAlpha),
        // Old persisted files predate the switch: missing → on (the look
        // users tuned); only an explicit false turns regions off.
        enabled: typeof input?.enabled === "boolean" ? input.enabled : true,
    };
}
export const DEFAULT_PHYSICS_TUNING = {
    chargeStrength: CHARGE_STRENGTH,
    linkStrength: 1,
    linkDistance: LINK_DISTANCE,
    gravity: INCREMENTAL_GRAVITY,
    clusterPull: CLUSTER_PULL_STRENGTH,
    velocityDecay: 0.4,
    depthMode: "off",
    // 0.8 by sweep on the real graph: 215/216 arrows read upward with
    // organic sag (mean |dev| from level ~34u at spacing 60); 1.5 gives
    // crisp rows (dev ~18) if the promoted default wants them.
    depthStrength: 0.8,
    depthSpacing: 60,
    depthBaseRadius: 220,
};
/** Clamp anything into a usable tuning (sliders/JSON can be empty/NaN). */
export function sanitizePhysicsTuning(input) {
    const d = DEFAULT_PHYSICS_TUNING;
    const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return {
        chargeStrength: Math.min(Math.max(num(input?.chargeStrength, d.chargeStrength), CHARGE_RANGE.min), CHARGE_RANGE.max),
        linkStrength: Math.min(Math.max(num(input?.linkStrength, d.linkStrength), LINK_STRENGTH_RANGE.min), LINK_STRENGTH_RANGE.max),
        linkDistance: Math.min(Math.max(num(input?.linkDistance, d.linkDistance), LINK_DISTANCE_RANGE.min), LINK_DISTANCE_RANGE.max),
        gravity: Math.min(Math.max(num(input?.gravity, d.gravity), GRAVITY_RANGE.min), GRAVITY_RANGE.max),
        clusterPull: Math.min(Math.max(num(input?.clusterPull, d.clusterPull), 0), CLUSTER_PULL_RANGE.max),
        velocityDecay: Math.min(Math.max(num(input?.velocityDecay, d.velocityDecay), VELOCITY_DECAY_RANGE.min), VELOCITY_DECAY_RANGE.max),
        depthMode: input?.depthMode === "vertical" || input?.depthMode === "radial" ? input.depthMode : "off",
        depthStrength: Math.min(Math.max(num(input?.depthStrength, d.depthStrength), DEPTH_STRENGTH_RANGE.min), DEPTH_STRENGTH_RANGE.max),
        depthSpacing: Math.min(Math.max(num(input?.depthSpacing, d.depthSpacing), DEPTH_SPACING_RANGE.min), DEPTH_SPACING_RANGE.max),
        depthBaseRadius: Math.min(Math.max(num(input?.depthBaseRadius, d.depthBaseRadius), DEPTH_BASE_RADIUS_RANGE.min), DEPTH_BASE_RADIUS_RANGE.max),
    };
}
// Sizes are WORLD UNITS (the 2026-09-15 pivot — see the ranges block
// below for the full story): the world scale is canonical, identical
// settings render identically at any graph size. The values are the
// 2026-09-13 re-tune (2px at fit on the reference graph) ÷ its kFit 0.69.
// The 2026-09-17 bake: the user's live-tuned values (tuned against the
// real graph after the world-unit pivot), each dead-center on its ladder.
export const DEFAULT_RENDER_SETTINGS = {
    sizeUnits: "world",
    nodeSize: 2,
    edgeWidth: 1,
    arrowLength: 2,
    // New default 0.5 — displays as 1× on the slider (owner, 2026-10-07:
    // "labels until zoom default one" — the owner speaks in display
    // values, and the display is ratio/0.5). Labels once zoomed past fit.
    labelZoom: 0.5,
    labelSize: 3,
    clusterLabels: true,
    clusterLabelSize: 14,
    regions: DEFAULT_REGION_TUNING,
    physics: DEFAULT_PHYSICS_TUNING,
};
// ─── The slider ladders (2026-09-17) ─────────────────────────────────────────
//
// Non-physics knobs move on hand-authored 11-stop ladders — the classic
// two-per-octave nice-number series (x1.5 / x1.33 alternation: quarter and
// half steps at the low end, integers above) — with the DEFAULT dead-center
// at index 5 / slider position 50. The slider steps by 10: one stop per
// detent, 21 positions → 11 values, all integers or clean fractions. The
// sanitizer snaps ANY incoming value to the nearest entry, so stored files
// can never hold (or render) 2.18137...977-style artifacts.
// Each ladder is authored around its DEFAULT at index 5: five stops down,
// five up, following the x1.5 / x4-3 alternation where it lands clean
// (powers of two at the floors where the series would go fractional).
export const NODE_SIZE_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12];
export const EDGE_WIDTH_LADDER = [0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4, 6];
export const ARROW_LENGTH_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12];
export const LABEL_SIZE_LADDER = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
// Screen px at any zoom (drawn at size / k). 14 = the old REGION_LABEL_SIZE.
export const CLUSTER_LABEL_SIZE_LADDER = [7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28];
// Camera-ratio gates; the DISPLAY ladder reads 1.5×, 2×, 3×, 4×, 6×, 8×,
// 12×, 16×, 24×, 32×, 48× (labelZoomDisplay) with the user's tuned 8×
// (ratio 4) dead-center — it used to sit at the very end of the axis.
// Re-centered on the new default (owner, 2026-10-07): display 1× (ratio
// 0.5) sits dead-center; the upper stops keep the old familiar run, the
// lower stops go finer where the default now lives. Old stored values
// snap to the nearest stop (4 → 3, 24 → 3, 0.75 → 0.75).
export const LABEL_ZOOM_LADDER = [0.125, 0.175, 0.25, 0.35, 0.45, 0.5, 0.75, 1, 1.5, 2, 3];
// ─── Region + physics slider ranges ──────────────────────────────────────────
//
// Same laws as the size sliders: log-scaled, DEFAULT AT 50 (each default is
// the geometric mean of its ends), coarse 5-step tracks. Signed/zeroed
// fields get special treatment:
//   chargeStrength is NEGATIVE — the slider maps |charge| and displays "-x";
//   clusterPull has an OFF zone — position 0 is exactly 0 (see
//   toOffSliderPosition), the log range starts one step in. Blur used to
//   have one too; it's a dropdown since 2026-09-13 (non-integers broke).
export const REGION_DILATION_LADDER = [4, 5, 7.5, 10, 15, 20, 30, 40, 60, 80, 120]; // world units
// Re-centered on the new default 40 (owner, 2026-10-07): min 10 per the
// owner's suggestion, the old ceiling 120 kept, and every old stop from
// 15 up survives (4/5/7.5 snap to 10).
export const REGION_BLUR_LADDER = [10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120]; // world units
export const REGION_EDGE_ALPHA_LADDER = [0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1];
export const CHARGE_RANGE = { min: -480, max: -120 }; // |gm| = 240 (2026-09-17: default −240, dead-center; a subrange of the sweep-validated [30, 480])
export const LINK_STRENGTH_RANGE = { min: 0.25, max: 4 }; // gm = 1
export const LINK_DISTANCE_RANGE = { min: 10, max: 160 }; // gm = 40
export const GRAVITY_RANGE = { min: 0.03, max: 0.48 }; // gm = 0.12
export const CLUSTER_PULL_RANGE = { min: 0.0225, max: 1 }; // gm = 0.15; 0 = off
export const VELOCITY_DECAY_RANGE = { min: 0.18, max: 0.9 }; // gm ≈ 0.40
export const DEPTH_STRENGTH_RANGE = { min: 0.2, max: 3.2 }; // gm = 0.8
export const DEPTH_SPACING_RANGE = { min: 15, max: 240 }; // gm = 60
export const DEPTH_BASE_RADIUS_RANGE = { min: 55, max: 880 }; // gm = 220
/** Nearest ladder entry (ties break LOW — deterministic). */
export function snapToLadder(value, ladder) {
    return ladder.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), ladder[0]);
}
/** Ladder index of a value (nearest; ties break low) — the slider position
 *  is index × 10 (step-10 track, 11 stops, default at 50). */
export function ladderIndex(value, ladder) {
    let best = 0;
    for (let i = 1; i < ladder.length; i++)
        if (Math.abs(ladder[i] - value) < Math.abs(ladder[best] - value))
            best = i;
    return best;
}
/** Setting value → ladder slider position [0, 100]. */
export function toLadderPosition(value, ladder) {
    return ladderIndex(clampToLadder(value, ladder), ladder) * 10;
}
/** Ladder slider position [0, 100] → setting value (the ladder entry). */
export function fromLadderPosition(position, ladder) {
    const i = Math.min(Math.max(Math.round(position / 10), 0), ladder.length - 1);
    return ladder[i];
}
/** Clamp a value into the ladder's span (no snapping — bounds only). */
function clampToLadder(value, ladder) {
    return clamp(value, ladder[0], ladder[ladder.length - 1]);
}
/** Off-aware slider mapping (position 0 → value 0 = OFF; the log range
 *  starts one step in). Inverse of fromOffSliderPosition. */
export function toOffSliderPosition(value, min, max) {
    if (value <= 0)
        return 0;
    return toSliderPosition(value, min, max);
}
/** Off-aware slider mapping: position 0 → 0 (off), else log-scaled. */
export function fromOffSliderPosition(position, min, max) {
    if (position <= 0)
        return 0;
    return fromSliderPosition(position, min, max);
}
/** Setting value → slider position [0, 100] (log scale, default at 50). */
export function toSliderPosition(value, min, max) {
    const v = clamp(value, min, max);
    const logSpan = Math.log(max / min);
    return (100 * Math.log(v / min)) / logSpan;
}
/** Slider position [0, 100] → setting value (inverse of toSliderPosition). */
export function fromSliderPosition(position, min, max) {
    const p = clamp(position, 0, 100) / 100;
    const logSpan = Math.log(max / min);
    return min * Math.exp(p * logSpan);
}
/** Display units for labelZoom: ABSOLUTE since 2026-09-17 (ratio / 0.5 —
 *  anchored to the historical pre-bake default, so "8×" keeps its meaning
 *  now that 4 IS the default; the old default-relative form would have
 *  relabeled the user's tuned 8× as "1×"). */
export function labelZoomDisplay(labelZoom) {
    const v = Math.round((labelZoom / 0.5) * 100) / 100;
    return `${v}×`;
}
//# sourceMappingURL=render-settings.js.map