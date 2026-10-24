/**
 * SESSION-SCOPED OVERLAYS (owner wave, 2026-09-19): the "fullscreen"
 * expansions — the plan focus, this mermaid focus — do NOT cover the app
 * chrome. They mount ABSOLUTE INSIDE THE SESSION AREA (the `relative` div
 * below the top bar, right of the sidebar, where the transcript and dock
 * live), so the 60px drag bar stays sharp, visible, and draggable and the X
 * can never land in drag territory — the old `fixed inset-0` overlays put it
 * exactly there, which is what drove this redesign. Surface: 80% background +
 * blur (user-decided) — the transcript ghosts through while the focus owns
 * the session area.
 *
 * The chart source registers from wherever it lives in the transcript
 * (md-blocks' expand button) via the context below; the CHAT PAGE owns the
 * open state so this overlay mounts as a sibling of the scroller inside the
 * session area — never inside it (an absolute inset-0 inside the scroller
 * would cover the scrollable extent, not the visible area).
 */
/** The expand seam: md-blocks' mermaid hover button calls openMermaid with
 *  the chart source; the figure card's fullscreen button calls openFigure
 *  with the raw svg (+ its invert state). The chat page (which provides
 *  this context) opens the overlay. Null when no chat page is mounted
 *  (sidebar previews etc.) — the buttons simply don't render there. */
export declare const SessionMermaidContext: any;
export declare function useSessionMermaid(): any;
/** A chart svg's natural size — mermaid always emits a viewBox; this is the
 *  extent at zoom 1 (1 svg unit = 1 px), like the plan diagram's natural
 *  size. Figure svgs (2026-10-07) may declare width/height instead — that
 *  pair is the fallback. The final fallback covers a degenerate svg with
 *  neither. Pure. */
export declare function chartSize(svg: string): {
    w: number;
    h: number;
};
/** The diagram focus: the chart at natural size inside a pan/zoom viewport
 *  (the plan popup's fit-floor semantics — fitGraphView/zoomedGraphView in
 *  pan-zoom.ts), Esc/X close. Renders its own copy of the chart (mermaid
 *  ids are per-render), not the injected inline svg. FIGURE MODE
 *  (2026-10-07): pass a raw `svg` instead of a mermaid `chart` — the same
 *  shell then focuses a figure card's svg on a white stage, with the
 *  caller's invert state carried over (the filter rides the white stage,
 *  exactly like the in-card holder). */
export declare function MermaidOverlay({ chart, svg: rawSvg, inverted, onClose, }: {
    chart?: string;
    svg?: string;
    inverted?: boolean;
    onClose: () => void;
}): any;
//# sourceMappingURL=session-overlay.d.ts.map