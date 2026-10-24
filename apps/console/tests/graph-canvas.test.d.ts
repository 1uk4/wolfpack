/**
 * Pure-helper tests for the hand-rolled canvas renderer
 * (components/graph-canvas.ts). The renderer class itself is DOM-bound
 * (canvas, rAF, ResizeObserver) and is verified live in the browser; the
 * math it runs on every frame must be exact, so it is pinned here.
 *
 * The camera-ratio convention is the load-bearing contract with the
 * persisted settings: sigma's ratio (1 = fit, SMALLER = zoomed in) is kept
 * verbatim so stored labelZoom values survive the renderer swap.
 */
export {};
//# sourceMappingURL=graph-canvas.test.d.ts.map