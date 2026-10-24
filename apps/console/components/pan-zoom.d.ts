/**
 * Shared pan/zoom viewport math — the "fit floor" semantics harvested from
 * the plan popup (plan-graph rounds 2–4) so the session overlays (the plan
 * focus, the mermaid focus) run the SAME geometry: fully zoomed out IS the
 * fit (whichever axis binds), panning locks at the floor (nothing to move),
 * wheel zooms to the cursor. Pure on purpose: the overlays are render-tested
 * in static markup (no live pointer events), so the math lives here where
 * tests can pin it (tests/pan-zoom.test.ts).
 */
/** Zoom ceiling for every surface that uses this math (raised 2×→4× for
 *  reading node titles closely, owner, plan-graph round 3). */
export declare const ZOOM_MAX = 4;
/** Viewport breathing room subtracted by the fit. */
export declare const FIT_PAD = 16;
/** The fit never zooms IN past this — a tiny diagram must not blow up. */
export declare const FIT_ZOOM_MAX = 1.5;
/** A pan/zoom viewport state (translate + scale; origin top-left). */
export interface Viewport {
    zoom: number;
    x: number;
    y: number;
}
/** The fit zoom for a box in a viewport: never below a true fit (the old
 *  0.15 floor could sit ABOVE the fit for wide graphs — the epsilon only
 *  guards degenerate viewports), never above FIT_ZOOM_MAX. Pure. */
export declare function fitZoomFor(box: {
    w: number;
    h: number;
}, viewport: {
    w: number;
    h: number;
}): number;
/** Centers a box (at the given zoom) in the viewport. Pure. */
export declare function fitGraphView(box: {
    w: number;
    h: number;
}, viewport: {
    w: number;
    h: number;
}, zoom: number): Viewport;
/** Zoom by `factor` keeping `focus` (viewport coordinates) visually fixed,
 *  clamped to [floor, ZOOM_MAX]. At the floor the view re-fits + RE-CENTERS
 *  (the fit IS the floor — a locked view there has nothing to move). Pure. */
export declare function zoomedGraphView(view: Viewport, factor: number, floor: number, focus: {
    x: number;
    y: number;
}, box: {
    w: number;
    h: number;
}, viewport: {
    w: number;
    h: number;
}): Viewport;
//# sourceMappingURL=pan-zoom.d.ts.map