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
export const ZOOM_MAX = 4;
/** Viewport breathing room subtracted by the fit. */
export const FIT_PAD = 16;
/** The fit never zooms IN past this — a tiny diagram must not blow up. */
export const FIT_ZOOM_MAX = 1.5;

/** A pan/zoom viewport state (translate + scale; origin top-left). */
export interface Viewport {
	zoom: number;
	x: number;
	y: number;
}

/** The fit zoom for a box in a viewport: never below a true fit (the old
 *  0.15 floor could sit ABOVE the fit for wide graphs — the epsilon only
 *  guards degenerate viewports), never above FIT_ZOOM_MAX. Pure. */
export function fitZoomFor(box: { w: number; h: number }, viewport: { w: number; h: number }): number {
	if (!viewport.w || !viewport.h || box.w === 0) return 1;
	return Math.max(0.02, Math.min((viewport.w - FIT_PAD) / box.w, (viewport.h - FIT_PAD) / box.h, FIT_ZOOM_MAX));
}

/** Centers a box (at the given zoom) in the viewport. Pure. */
export function fitGraphView(box: { w: number; h: number }, viewport: { w: number; h: number }, zoom: number): Viewport {
	return { zoom, x: (viewport.w - box.w * zoom) / 2, y: (viewport.h - box.h * zoom) / 2 };
}

/** Zoom by `factor` keeping `focus` (viewport coordinates) visually fixed,
 *  clamped to [floor, ZOOM_MAX]. At the floor the view re-fits + RE-CENTERS
 *  (the fit IS the floor — a locked view there has nothing to move). Pure. */
export function zoomedGraphView(
	view: Viewport,
	factor: number,
	floor: number,
	focus: { x: number; y: number },
	box: { w: number; h: number },
	viewport: { w: number; h: number },
): Viewport {
	const zoom = Math.min(Math.max(view.zoom * factor, floor), ZOOM_MAX);
	if (zoom === view.zoom) return view;
	if (zoom <= floor) return fitGraphView(box, viewport, floor);
	const k = zoom / view.zoom;
	return { zoom, x: focus.x - (focus.x - view.x) * k, y: focus.y - (focus.y - view.y) * k };
}

/**
 * Fit with a readable floor (the Prompts graphs): the scale that fits the whole box, never above 1. If that is below `minScale`
 * the graph would be unreadable, so it fits the HEIGHT instead (never below `minScale`) and starts at the left edge so the rest
 * pans. An axis that fits is centred; one that overflows starts at the padded edge. Pure.
 */
export function fitFloorView(box: { w: number; h: number }, viewport: { w: number; h: number }, minScale: number): Viewport {
	if (!viewport.w || !viewport.h || !box.w || !box.h) return { zoom: 1, x: 0, y: 0 };
	const wFit = (viewport.w - FIT_PAD) / box.w;
	const hFit = (viewport.h - FIT_PAD) / box.h;
	const whole = Math.min(wFit, hFit, 1);
	const zoom = whole >= minScale ? whole : Math.max(minScale, Math.min(hFit, 1));
	const place = (b: number, v: number, z: number) => (b * z <= v ? (v - b * z) / 2 : FIT_PAD / 2);
	return { zoom, x: place(box.w, viewport.w, zoom), y: place(box.h, viewport.h, zoom) };
}
