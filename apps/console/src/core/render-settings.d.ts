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
import { type DepthAnchorMode } from "./layout.ts";
export interface GraphRenderSettings {
    /** Semantic stamp for the size-unit pivot (2026-09-15): "world" =
     *  nodeSize/labelSize/arrowLength/regions.dilation are WORLD units;
     *  absent = the old "screen px at fit zoom" semantics — the
     *  sanitizer resets those four fields (their meaning changed, not
     *  their magnitude) and keeps everything else. */
    sizeUnits: "world";
    nodeSize: number;
    edgeWidth: number;
    arrowLength: number;
    /** Camera-ratio threshold for node labels (see module doc). */
    labelZoom: number;
    /** Node + hover label font size, WORLD units (scales with camera). */
    labelSize: number;
    /** Toggle for the cluster region labels (hulls always draw). */
    clusterLabels: boolean;
    /** Cluster label font size, px on screen (camera-compensated —
     *  constant at any zoom, unlike labelSize which scales with the
     *  graph). Defaults to the old REGION_LABEL_SIZE constant (14). */
    clusterLabelSize: number;
    /** Region rendering (the blurred cluster tints). Server-persisted
     *  since 2026-09-13 (user request) — was session-only dev state. */
    regions: RegionTuning;
    /** Live-sim physics + inference-depth anchoring. Server-persisted
     *  since 2026-09-13 (user request) — was session-only dev state. */
    physics: PhysicsTuning;
}
/**
 * Coerce arbitrary JSON (server file, network body, localStorage leftovers)
 * into valid settings: missing keys fall back to defaults, out-of-range
 * values clamp, wrong types reset. Never throws.
 */
export declare function sanitizeRenderSettings(raw: unknown): GraphRenderSettings;
/** Region rendering knobs (the blurred cluster tints). */
export interface RegionTuning {
    /** Dilation half-width of the round-cap edge strokes, WORLD units
     *  (the expansion of the cluster skeleton). */
    dilation: number;
    /** Region softness: the blur's reach, WORLD units (3 box-blur
     *  passes ≈ Gaussian). The 2026-09-15 world-unit pivot ended the
     *  bitmap-px era — the old reach scaled with the graph's span
     *  (blur × span / bitmap), so the same value read 6× softer on a
     *  338-node graph than on a 13-node one. Now the reach is canonical
     *  like dilation; the renderer rasterizes it (round to bitmap px,
     *  floor 1px when the graph out-resolves the blur). */
    blur: number;
    /** Max bitmap dimension (cell = worldSpan / this). Fixed set:
     *  see REGION_BITMAP_OPTIONS (dropdown in the panel). */
    bitmap: number;
    /** Region alpha, applied ONCE after the blur (dilate at full
     *  opacity → blur → scale). Constant interior, soft edges; overlaps
     *  of any count never stack (DECIDED 2026-09-14 — per-stroke alpha
     *  accumulated through source-over and double-counted orphans). */
    edgeAlpha: number;
    /** THE off switch (user 2026-09-15): false = the renderer never runs
     *  the region build — no splat, no blur, no readback, no bitmap
     *  allocation, no blit. Compute skipped, not just paint hidden.
     *  Cluster labels are decoupled and follow `clusterLabels`. */
    enabled: boolean;
}
export declare const REGION_BITMAP_OPTIONS: readonly [128, 192, 256, 384, 512];
export declare const DEFAULT_REGION_TUNING: RegionTuning;
/** Clamp/validate a region tuning. `bitmap` snaps to the nearest allowed
 *  option (a fixed set — dropdown, not a free number). */
export declare function sanitizeRegionTuning(input: Partial<RegionTuning> | null | undefined): RegionTuning;
/** Live-sim physics controls (user-facing since 2026-09-13): every value
 *  feeds createGraphSimulation — the SAME engine the server settle runs —
 *  so tuning the feel changes exactly what a drag relaxes toward. */
export interface PhysicsTuning {
    /** Node repulsion (d3 charge, negative = push apart). */
    chargeStrength: number;
    /** Edge attraction: link-spring stiffness multiplier (1 = d3 default). */
    linkStrength: number;
    /** Link spring rest length (world units). */
    linkDistance: number;
    /** Central pull toward the graph centroid. */
    gravity: number;
    /** Per-cluster pull toward the cluster centroid. 0 = off. */
    clusterPull: number;
    /** Per-tick velocity damping (d3 default 0.4). */
    velocityDecay: number;
    /** Inference-depth anchoring mode (see DepthAnchor in core). */
    depthMode: DepthAnchorMode;
    /** Depth-anchor pull strength. */
    depthStrength: number;
    /** Spacing between inference levels (world units). */
    depthSpacing: number;
    /** Inner ring radius, radial mode (world units). */
    depthBaseRadius: number;
}
export declare const DEFAULT_PHYSICS_TUNING: PhysicsTuning;
/** Clamp anything into a usable tuning (sliders/JSON can be empty/NaN). */
export declare function sanitizePhysicsTuning(input: Partial<PhysicsTuning> | null | undefined): PhysicsTuning;
export declare const DEFAULT_RENDER_SETTINGS: GraphRenderSettings;
export declare const NODE_SIZE_LADDER: readonly [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12];
export declare const EDGE_WIDTH_LADDER: readonly [0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4, 6];
export declare const ARROW_LENGTH_LADDER: readonly [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12];
export declare const LABEL_SIZE_LADDER: readonly [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
export declare const CLUSTER_LABEL_SIZE_LADDER: readonly [7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28];
export declare const LABEL_ZOOM_LADDER: readonly [0.125, 0.175, 0.25, 0.35, 0.45, 0.5, 0.75, 1, 1.5, 2, 3];
export declare const REGION_DILATION_LADDER: readonly [4, 5, 7.5, 10, 15, 20, 30, 40, 60, 80, 120];
export declare const REGION_BLUR_LADDER: readonly [10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120];
export declare const REGION_EDGE_ALPHA_LADDER: readonly [0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1];
export declare const CHARGE_RANGE: {
    readonly min: -480;
    readonly max: -120;
};
export declare const LINK_STRENGTH_RANGE: {
    readonly min: 0.25;
    readonly max: 4;
};
export declare const LINK_DISTANCE_RANGE: {
    readonly min: 10;
    readonly max: 160;
};
export declare const GRAVITY_RANGE: {
    readonly min: 0.03;
    readonly max: 0.48;
};
export declare const CLUSTER_PULL_RANGE: {
    readonly min: 0.0225;
    readonly max: 1;
};
export declare const VELOCITY_DECAY_RANGE: {
    readonly min: 0.18;
    readonly max: 0.9;
};
export declare const DEPTH_STRENGTH_RANGE: {
    readonly min: 0.2;
    readonly max: 3.2;
};
export declare const DEPTH_SPACING_RANGE: {
    readonly min: 15;
    readonly max: 240;
};
export declare const DEPTH_BASE_RADIUS_RANGE: {
    readonly min: 55;
    readonly max: 880;
};
/** Nearest ladder entry (ties break LOW — deterministic). */
export declare function snapToLadder(value: number, ladder: readonly number[]): number;
/** Ladder index of a value (nearest; ties break low) — the slider position
 *  is index × 10 (step-10 track, 11 stops, default at 50). */
export declare function ladderIndex(value: number, ladder: readonly number[]): number;
/** Setting value → ladder slider position [0, 100]. */
export declare function toLadderPosition(value: number, ladder: readonly number[]): number;
/** Ladder slider position [0, 100] → setting value (the ladder entry). */
export declare function fromLadderPosition(position: number, ladder: readonly number[]): number;
/** Off-aware slider mapping (position 0 → value 0 = OFF; the log range
 *  starts one step in). Inverse of fromOffSliderPosition. */
export declare function toOffSliderPosition(value: number, min: number, max: number): number;
/** Off-aware slider mapping: position 0 → 0 (off), else log-scaled. */
export declare function fromOffSliderPosition(position: number, min: number, max: number): number;
/** Setting value → slider position [0, 100] (log scale, default at 50). */
export declare function toSliderPosition(value: number, min: number, max: number): number;
/** Slider position [0, 100] → setting value (inverse of toSliderPosition). */
export declare function fromSliderPosition(position: number, min: number, max: number): number;
/** Display units for labelZoom: ABSOLUTE since 2026-09-17 (ratio / 0.5 —
 *  anchored to the historical pre-bake default, so "8×" keeps its meaning
 *  now that 4 IS the default; the old default-relative form would have
 *  relabeled the user's tuned 8× as "1×"). */
export declare function labelZoomDisplay(labelZoom: number): string;
//# sourceMappingURL=render-settings.d.ts.map