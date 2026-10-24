import type { PlanBlockData, PlanNodeStatus, PlanTree } from "@/src/core";
/**
 * PLAN BLOCKS — the plan lives in the chat (wave 4): persisted
 * `data-plan-block` parts render as DAG blocks in the transcript flow, and
 * the right sidebar is retired.
 *
 * - kind "full": the whole DAG, BORDERLESS — no wrapping chrome, the SVG
 *   scales to the full column width (viewBox = layout extent + GRAPH_PAD,
 *   so strokes/glow never clip), natural height, capped at the chat prose
 *   font size (TEXT_CAP_SCALE — fills the column, never oversizes text).
 * - Clicking opens the full plan in a session-scoped focus overlay
 *   (absolute inside the session area, below the drag bar — chrome-melt
 *   wave, 2026-09-19; was a fixed inset-0 full-screen popup) —
 *   the LIVE plan: the latest tree from the transcript with statuses
 *   derived at click time (contracts/plan.ts derivePlanStatuses). Blocks
 *   are frozen snapshots rendered exactly as carried (never re-derived);
 *   the popup is the live view (user decision, 2026-09).
 *
 * Hand-built SVG everywhere (user decision): placement runs on dagre
 * (mermaid's engine — deterministic, synchronous, DOM-free, so SSR and
 * render tests stay exact); the skin is ours — no coupling to the graph
 * stream's internals. Pan/zoom in the popup
 * is harvested from the retired tree panel's graph (fit-floor semantics:
 * fully zoomed out IS the fit; panning locks at the floor).
 */
/** Text-first node sizing (owner, plan-hug round 2026-10-07): the box
 * hugs its wrapped text instead of a fixed 160px slab. Width comes from
 * the wrapped lines — a per-character-CLASS width estimate (the flat
 * px/char rate of the first cut overshot the real rendered width, and
 * the invisible slack read as "a lot of empty space" beside the text;
 * owner follow-up 2026-10-07) plus symmetric padding, floored at a
 * minimum so short titles don't collapse into pills. Estimate, NOT
 * canvas measurement: the layout path stays deterministic,
 * synchronous, and DOM-free (SSR + exact render pins keep working). */
/** Symmetric horizontal padding — EQUALS the vertical padding the
 * single-line text gets in NODE_H (owner: "the horizontal padding
 * should be the same as the vertical one"): (44 − 11) / 2 ≈ 16 (the
 * prose font renders text-xs at 11px). */
export declare const PAD_X = 16;
export declare const NODE_W_MIN = 96;
export declare const NODE_H = 44;
/** Estimated rendered width (px) of one line at text-xs. Pure. */
export declare function estimateLineWidth(line: string): number;
/** Baseline-to-baseline distance of node titles. */
export declare const LINE_H = 13;
export declare const GAP_X = 24;
export declare const GAP_Y = 48;
/** A node for layout purposes — the payload's shape and the tree's shape agree. */
export interface LayoutNode {
    id: string;
    title: string;
}
/** Topological order + longest-path depth (Kahn, authoring tie-break) —
 *  order + depth semantics kept for tests; placement itself runs on dagre
 *  now (owner, round 8). */
export declare function topoFor(nodes: readonly LayoutNode[], edges: ReadonlyArray<{
    from: string;
    to: string;
}>): {
    order: LayoutNode[];
    depth: Map<string, number>;
};
/** Placement — dagre (mermaid's engine, owner round 8): Sugiyama-style
 *  layered layout, TB, with our geometry (text-first sized boxes,
 *  GAP_X/GAP_Y
 *  separations, zero margin — the caller adds GRAPH_PAD/POPUP_PAD).
 *  Node sizes are fed in (boxes grow with their wrapped content, round
 *  7); dagre returns node CENTERS, we hand back top-lefts like before,
 *  so every consumer (diagram, popup fit, plan window) is unchanged.
 *  Deterministic + synchronous + DOM-free: SSR and render tests stay
 *  exact. Dangling edges are ignored defensively — a ghost endpoint
 *  would spawn an unmeasured node and break the measurer. */
export declare function blockLayout(nodes: readonly LayoutNode[], edges: ReadonlyArray<{
    from: string;
    to: string;
}>): {
    x: Map<string, number>;
    y: Map<string, number>;
    nodeH: Map<string, number>;
    nodeW: Map<string, number>;
    edgePts: Map<string, {
        x: number;
        y: number;
    }[]>;
    width: number;
    height: number;
    originX?: undefined;
    originY?: undefined;
} | {
    x: Map<string, number>;
    y: Map<string, number>;
    nodeH: Map<string, number>;
    nodeW: Map<string, number>;
    edgePts: Map<string, {
        x: number;
        y: number;
    }[]>;
    originX: number;
    originY: number;
    width: number;
    height: number;
};
/** Greedy word wrap to lines of ≤ maxChars — NOTHING is dropped: the
 *  node's box grows to fit every line (owner: show the full content of
 *  each node). A single oversized word is hard-chunked across lines at
 *  maxChars. Pure. */
export declare function wrapTitle(title: string, maxChars?: number): string[];
/** A node's box width for its wrapped lines — the hug itself. Pure. */
export declare function nodeWidth(lines: readonly string[]): number;
/** SVG-unit padding around the layout extent: strokes are centered on the
 *  geometry (half bleeds outside the extent) and the glow halo reaches −4 —
 *  without this pad the outermost node borders clip at the svg edge. */
export declare const GRAPH_PAD = 8;
/** The current node's yellow glow: a fill blurred so it bleeds over the
 *  node's edges (owner). A Gaussian's visible spread is ≈3σ, so the glow
 *  reaches GLOW_MARGIN + 3·GLOW_BLUR past the node — any surface that
 *  shows the glow must pad its viewBox by GLOW_REACH or the blur clips
 *  at the frame edge (owner: extend the container padding to fit it). */
export declare const GLOW_MARGIN = 8;
export declare const GLOW_BLUR = 5;
export declare const GLOW_REACH: number;
/** Node titles render at text-xs (12.5px) in svg units. The in-chat block
 *  scales up to fill the column but NEVER past the chat prose size
 *  (--lh-prose-size, 16px — the ladder's reading rung) — the width cap
 *  that makes that hold. */
export declare const TEXT_CAP_SCALE: number;
/** Baked from arrowhead_1.svg (the CM/MJX long-arrow head), transform chain
 *  collapsed: viewBox 0 0 50.2 104, tip at (50.2, 52), notch mouth at
 *  x 27.2 with a 9.6-tall opening — at full height 104 the tail opening
 *  is ≈10, per the owner's spec. Solid white fill, no padding. */
export declare const ARROW_HEAD = "M48,55.2C49.4,54.6 50.2,53.4 50.2,52C50.2,50.6 49.4,49.4 48,48.8C38.2,45.6 29.2,38.8 21,28.4C15.2,21.4 11.4,13.2 9.6,3.8C9,1.2 7.4,0 4.8,0C1.6,0 0,1.6 0,5L0.2,5.6C3.6,23 12.6,36.8 27.2,47.2L27.2,56.8C12.6,67.2 3.6,81 0.2,98.4L0,99C0,102.4 1.6,104 4.8,104C7.4,104 9,102.8 9.6,100.2C11.4,90.8 15.2,82.6 21,75.6C29.2,65.2 38.2,58.4 48,55.2Z";
/** Lines + outlines run at the app's standard border weight (owner,
 *  2026-09-26 — same 1px the UI borders use; was 1.5). */
export declare const STROKE_W = 1;
/** The edge path — mermaid's own line drawing: dagre's border-intersected
 *  waypoints through d3's curveBasis (mermaid's default flowchart curve —
 *  the same recipe dagre-d3's renderer uses). The head docks off the
 *  target: its TIP floats DOCK_GAP past the border along the FACE NORMAL
 *  (constant gap at any tilt), its mouth sits at the path's end on a
 *  straight run (the shaft stub), and — when the target box is given —
 *  the entry direction is clamped to ±ENTRY_ANGLE_LIMIT of the face's
 *  perpendicular (owner, round 14): a steeper natural approach swings to
 *  the 40° cone edge instead of breaking the head's silhouette. Without
 *  a target box the unclamped geometry applies. Straight collinear
 *  routes render identically. Pure, exported for tests. */
export declare function edgePathD(points: Array<{
    x: number;
    y: number;
}>, target?: {
    x: number;
    y: number;
    w: number;
    h: number;
}): string;
/** The diagram itself: positioned nodes + bezier edges. Pure-ish render —
 *  every input is data, so SSR render tests pin the whole thing. The root
 *  sets font-family var(--font-prose): node titles render in the READING
 *  font, not the mono UI font (owner, 2026-09-26) — and the runtime var
 *  rides the Appearance reading-font override (the utility can't: @theme
 *  inline bakes literals — the --font-title trap). */
export declare function PlanDiagram({ nodes, edges, statusOf, glowId, markerId, viewBoxOverride, pad: padUnits, textCapScale, naturalSize, monochrome, fill, }: {
    nodes: readonly LayoutNode[];
    edges: ReadonlyArray<{
        from: string;
        to: string;
    }>;
    statusOf: (id: string) => PlanNodeStatus;
    glowId?: string | null;
    markerId: string;
    /** A windowed viewBox (the plan window) instead of the full extent. */
    viewBoxOverride?: string;
    /** Pads the viewBox by this many svg units so centered strokes and the
     *  glow halo never clip at the extent edges (full-extent renders only). */
    pad?: number;
    /** Caps the rendered width at extent × scale — the chat-font-size zoom
     *  ceiling for the in-chat block (fills the column, never past prose). */
    textCapScale?: number;
    /** Renders at the viewBox width in px (1 svg unit = 1 px at zoom 1) —
     *  the popup's transform math depends on it; w-full inside the popup's
     *  shrink-to-fit wrapper resolved to the popup width and broke fit. */
    naturalSize?: boolean;
    /** The in-chat block's mode: every node white (fill-none, white stroke
     *  and text, no glow) — statuses never show in the transcript (owner). */
    monochrome?: boolean;
    /** Meet-fits the diagram inside a fixed box (h-full w-full — the svg's
     *  default preserveAspectRatio centers + contains the viewBox): the
     *  dock band's marginalia mode, where the diagram must fit BOTH the
     *  flank's width and the band's height rather than run width-first. */
    fill?: boolean;
}): any;
/**
 * A persisted plan-block part, rendered as carried (snapshot statuses,
 * never re-derived): borderless and column-filling, it opens the live plan
 * popup. Full-only by design since the 2026-09-11 pivot (the neighborhood
 * fragments are retired — position derives live in the popup and the
 * future DAG window).
 */
export declare function PlanBlock({ data, onOpen }: {
    data: PlanBlockData;
    onOpen: () => void;
}): any;
/** Minimal structural message slice (same trick as phases.ts). */
export interface PopupMessage {
    parts: ReadonlyArray<{
        type: string;
        state?: string;
        input?: unknown;
        output?: unknown;
    }>;
}
/** The latest plan tree in the transcript (latest tool-plan_ output). */
export declare function latestTree(messages: readonly PopupMessage[]): PlanTree | null;
/**
 * The full plan, live: latest tree + statuses derived at click time. Esc,
 * backdrop click, or the X close it; drag pans, wheel zooms to the cursor,
 * the zoom floor is the fit (panning locks at it — nothing to move).
 *
 * SESSION-SCOPED since the chrome-melt wave (2026-09-19): it mounts
 * ABSOLUTE inside the chat page's session-area div (chat.tsx) — below the
 * 60px drag bar, right of the sidebar — instead of a fixed inset-0 overlay.
 * The top bar stays sharp and draggable, and the X can never land in drag
 * territory. Surface 80% + blur (owner decision): the transcript ghosts
 * through while the focus owns the session area.
 */
export declare function PlanPopup({ messages, onClose }: {
    messages: readonly PopupMessage[];
    onClose: () => void;
}): any;
//# sourceMappingURL=plan-block.d.ts.map