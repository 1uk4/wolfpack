import { type Pt } from "./cluster-geometry.ts";
import { type PhysicsTuning, type RegionTuning, type GraphRenderSettings, type Position } from "@/src/core";
export type { GraphRenderSettings };
/** One node to draw: world-space position + the short glanceable label. */
export interface CanvasNode {
    id: string;
    x: number;
    y: number;
    label: string;
}
/** One directed edge of the DERIVED view (chains-primary, 2026-09-30):
 *  premise → implication node → conclusion, UNTYPED, all PLAIN
 *  single-shaft arrows — there is no double-shaft glyph anywhere
 *  (the 2026-09-14 ruling died with typed edges). An argument renders
 *  as its geometry: co-premise lines converge HEADLESS onto the
 *  implication point, one arrowed line leaves it; a single-premise
 *  argument is one ordinary arrow (see deriveView). */
export interface CanvasEdge {
    from: string;
    to: string;
}
/** Implication-node ids (the mint law: newGraphChainId in core/graph.ts).
 *  On the canvas an imp node is PURE GEOMETRY (owner, rendering arc
 *  2026-09-30): invisible — no disc, no label — and UNPICKABLE,
 *  excluded from every hit-test path. Exported for the test pin. */
export declare const isImpNodeId: (id: string) => boolean;
/** One cluster region: member node ids + the LLM-coined label (or null). */
export interface CanvasCluster {
    id: string;
    label: string | null;
    members: string[];
}
/** Theme colors, resolved to #rrggbb by the caller (canvas wants hex,
 *  and the renderer must not read CSS itself). */
export interface CanvasColors {
    node: string;
    edge: string;
    label: string;
    hoverText: string;
}
export interface CanvasData {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
    /** The LOGICAL arrows (proposition→conclusion, imp contracted) the
     *  depth force consumes — absent = the sim derives depth from the
     *  drawn edges (legacy). Optional so non-graph callers of the
     *  renderer stay simple. */
    logicalEdges?: CanvasEdge[];
    /** The imp chain linkage — the depth pass anchors each junction at
     *  the premises/conclusion midpoint (owner, 2026-09-30). */
    impLinks?: ReadonlyArray<{
        id: string;
        premises: ReadonlyArray<string>;
        conclusion: string;
    }>;
    clusters: CanvasCluster[];
    colors: CanvasColors;
    /** Body font family (labels must match the app typography). */
    fontFamily: string;
}
export interface RendererCallbacks {
    /** A node was clicked (screen position included for card anchoring). */
    onSelect: (nodeId: string, screenPos: Pt) => void;
    /** Right-click: the picked node (canvas-relative screen position) or
     *  null when the pointer hit empty stage — the caller opens/closes
     *  its context menu accordingly. (node interlude, wave 7) */
    onContext: (nodeId: string | null, screenPos: Pt) => void;
    /** The empty stage was clicked. */
    onStageClick: () => void;
    /** Any camera move (pan/zoom) — the caller dismisses anchored UI and
     *  persists the camera (view state). */
    onCameraMove: (transform: {
        k: number;
        x: number;
        y: number;
    }) => void;
    /** The live sim settled after a drag: commit the new rest state
     *  (the caller PUTs it to the positions ledger). */
    onCommit: (positions: Record<string, Position>) => void;
}
/** Wrap one region label: word-wise first (session names), then
 *  char-wise for words alone wider than the max (long file paths — the
 *  node-label discipline), capped at maxLines. Overflow folds into the
 *  last line, ellipsized to fit. measure is the canvas measureText (or a
 *  fake in tests) — pure otherwise. */
export declare function wrapRegionLabel(text: string, maxWidth: number, maxLines: number, measure: (s: string) => number): string[];
/** Label-only cluster patch (rename-shuffle fix, 2026-09-23): apply a set
 *  of live label updates to the data-side cluster records AND the built
 *  region meta (re-wrapping the changed entries with the provided
 *  measure — the same wrap a geometry build would produce). The
 *  hull-silence guard travels here: a cluster whose CURRENT label is
 *  null is a gone record — no rename can reach it. Pure, in-place on the
 *  provided arrays; returns whether anything changed (the caller only
 *  redraws when it did). Exported for tests. */
export declare function applyClusterLabels(clusters: {
    id: string;
    label: string | null;
}[], regionMeta: {
    id: string;
    label: string | null;
    lines: string[] | null;
}[], labels: ReadonlyMap<string, string | null>, maxWidth: number, maxLines: number, measure: (s: string) => number): boolean;
/** The node→cluster label cross-fade spans gate × this (camera-ratio
 *  units) — PROPORTIONAL since 2026-09-17. The old absolute span (0.5
 *  ratio) read as a 100% relative change at the old 0.5 gate but a bare
 *  12% sliver at the tuned 8x gate (ratio 4): "lower zoom levels naturally
 *  produce a longer transitionary period while higher ones are more
 *  abrupt" — the user's exact observation. Proportional keeps ONE
 *  transitionary feel at any gate; at the 8x default the handoff fades
 *  across a full stop (8x → 12x). */
export declare const LABELS_FADE_RATIO = 0.5;
/** One horizontal+vertical box-blur round over PREMULTIPLIED RGBA
 *  (Float32, stride 4, length w*h*4). Premultiplying first is what keeps
 *  the blur halo-free: blurring non-premultiplied RGB over varying alpha
 *  bleeds solid color into transparent space. Pure: DOM-free, tested. */
export declare function boxBlurRound(src: Float32Array, tmp: Float32Array, dst: Float32Array, w: number, h: number, radius: number): void;
/**
 * The sigma-compatible "camera ratio": 1 at fit zoom, SMALLER when zoomed
 * in (ratio = kFit / k). The persisted labelZoom setting is denominated in
 * these units, so the gate semantics survive the renderer swap unchanged.
 */
export declare function zoomRatioOf(kFit: number, k: number): number;
/**
 * Node-label opacity at a given camera ratio: 1 at/below the labelZoom
 * threshold, fading to 0 across a span of labelZoom x LABELS_FADE_RATIO
 * (see there). Cluster labels use `1 - this` over the same span — the
 * two cross-fade and never coexist at full opacity.
 */
export declare function labelAlpha(ratio: number, labelZoom: number, span?: number): number;
/** The camera transform that frames `bbox` in a w×h viewport with padding. */
export declare function fitTransform(bbox: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}, w: number, h: number, padding: number): {
    x: number;
    y: number;
    k: number;
};
/** The arrowhead geometry for a directed edge a→b: shaft endpoints
 *  (clear of both node discs) and the head triangle (tip on the target
 *  disc edge, wideness = 0.8 × head length — the sigma arrow shape). */
/** One complete arrow glyph: shaft + head triangle. */
export interface ArrowGeom {
    shaftFrom: Pt;
    shaftTo: Pt;
    tip: Pt;
    left: Pt;
    right: Pt;
}
export declare function arrowGeometry(a: Pt, b: Pt, fromRadius: number, toRadius: number, headLength: number): ArrowGeom | null;
/** Nearest node within maxDist of a screen point (linear scan — µs at
 *  our scale; a spatial grid only earns its keep past ~10k nodes). */
export declare function pickNearest<T extends {
    id: string;
    x: number;
    y: number;
}>(nodes: T[], px: number, py: number, maxDist: number): T | null;
export declare class GraphCanvasRenderer {
    private canvas;
    private ctx;
    private callbacks;
    private zoomBehavior;
    private transform;
    /** Set once the first fit happens; the camera then survives setData. */
    private hasFit;
    /** Last-synced CSS size — the resize anchor computes the world point
     *  under the PRE-resize viewport center from these (ResizeObserver
     *  callbacks already see the NEW size in clientWidth/Height). */
    private viewW;
    private viewH;
    /** The k that frames the whole graph — the label-gate's "1×". */
    private kFit;
    /** World-space bounds of the current nodes — fit() and the resize-time
     *  kFit refresh share it (computed once per setData, not per resize). */
    private worldBBox;
    private data;
    /** id -> node for the current data (avoids O(n^2) scans). */
    private nodeById;
    private settings;
    private visible;
    private sim;
    private simById;
    private simActive;
    private dragId;
    private dragOrigin;
    private simMoved;
    private commitTimer;
    private frameId;
    private dirty;
    /** True while tick() runs: markDirty inside the loop (d3's zoom event
     *  fires from advanceZoom) must NOT schedule — the loop schedules
     *  itself below. Un-guarded, each glide frame leaked an extra queued
     *  tick and draws multiplied per displayed frame (20fps zoom bug). */
    private inTick;
    private hoverId;
    /** The node the glow is drawn on. OUTLIVES hoverId on hover-out so the
     *  fade has something to draw (hoverId nulls instantly; without this
     *  the glow popped off in one frame instead of fading). Cleared when
     *  the outgoing fade completes. */
    private hoverNode;
    private hoverFade;
    private hoverFrom;
    private hoverTarget;
    private hoverStart;
    private zoomTarget;
    /** Clock for frame-rate-independent easing (updated every tick). */
    private lastTickAt;
    private animating;
    private resizeObserver;
    private downPos;
    private geoVersion;
    private builtVersion;
    private nodesPath;
    private shaftsPath;
    private headsPath;
    private regionCanvas;
    /** World rect the bitmap covers (drawImage target coords). */
    private regionRect;
    /** Region labels: cluster centroid + hue, computed at splat build. */
    private regionMeta;
    private regionTuning;
    private physicsTuning;
    /** Gravity center for the live sim (graph bbox centroid at setData). */
    private simCenter;
    private regionBuiltVersion;
    private frameCount;
    private labelLines;
    private worldLabelFont;
    private world;
    constructor(canvas: HTMLCanvasElement, callbacks: RendererCallbacks, 
    /** The caller's persisted camera (view state — localStorage): when
     *  present it REPLACES the first-open fit; the graph opens exactly
     *  where the user left it (2026-09-15: a default zoom exists only
     *  on first open, ever). Invalid shapes fall back to fit. */
    initialCamera?: {
        k: number;
        x: number;
        y: number;
    } | null);
    setData(data: CanvasData): void;
    setSettings(settings: GraphRenderSettings): void;
    /** Dev tuning for region rendering (session-only, never persisted):
     *  invalid numbers fall back to defaults — the number inputs can be
     *  emptied while typing. Forces a region bitmap rebuild. */
    setRegionTuning(input: Partial<RegionTuning>): void;
    /** Live-sim physics controls: rebuilds the sim from the CURRENT
     *  node positions (same node objects — x/y and any drag pin fx/fy
     *  survive; velocities restart clean, which reads as "re-relax with
     *  the new feel"). A mid-settle change re-anneals, which is the
     *  honest response to new physics. */
    setPhysicsTuning(input: Partial<PhysicsTuning>): void;
    /** Label-only channel (rename-shuffle fix, 2026-09-23): live
     *  cluster-label updates with NO setData. The rename path used to
     *  build a fresh snapshot object, which flowed setData → geometry
     *  rebuild — and the rebuild treats the last-fetched ledger as
     *  authoritative and cancels any pending drag commit, so a rename
     *  visibly rewound the whole graph whenever display had drifted
     *  (recent drag, mid-anneal, physics re-anneal). This channel touches
     *  ONLY label text: the region meta the draw pass reads plus the
     *  data-side cluster record (so the next geometry rebuild —
     *  visibility/settings/size — keeps the fresh label). Nodes, the
     *  sim, positions, and the pending commit are never touched. */
    setClusterLabels(labels: ReadonlyMap<string, string | null>): void;
    setVisible(visible: ReadonlySet<string> | null): void;
    /** Frame the whole graph (padding included). Keeps the camera on later
     *  setData calls — call fit() only for an explicit re-frame (the
     *  first-ever open; afterwards the caller-persisted camera wins). */
    fit(): void;
    /** Refresh the label-gate's "1×" reference from the current bbox +
     *  viewport. kFit feeds ONLY zoomRatioOf now (the 2026-09-15 pivot
     *  removed it from geometry) — so this never touches geoVersion. */
    private refreshFitZoom;
    destroy(): void;
    /** Wheel: accumulate the zoom target; the camera GLIDES toward it in the
     *  tick loop (cursor-anchored). Sensitivity formula is d3-zoom's own. */
    private onWheel;
    private onPointerMove;
    private onPointerDown;
    private onPointerUp;
    /** Right-click: pick the node under the pointer, hand the position to
     *  the caller (empty stage = null — the caller closes any open menu). */
    private onContextMenu;
    private onPointerLeave;
    private eventPos;
    private pickAt;
    private setHover;
    private markDirty;
    private tick;
    /** One live-sim step; returns true while physics is still in motion.
     *  Runs only while simActive (drag reheat or post-release anneal). */
    private advanceSim;
    /** Debounced rest-state commit. A new drag or setData cancels it. */
    private scheduleCommit;
    /** Hover fade step; returns true while still moving. */
    private advanceHover;
    /** Zoom glide step: ease k toward the wheel target, keeping the world
     *  point under the cursor pinned. Frame-rate independent (exponential
     *  approach, time constant ZOOM_EASE_MS). Returns true while gliding. */
    private advanceZoom;
    /** Resize the backing store to the CSS box × devicePixelRatio; all
     *  drawing then happens in CSS pixels through the DPR transform. */
    private syncSize;
    /** Derive ALL world geometry from data + visibility + settings.
     *  Runs only when geoVersion moves — never per frame, never per camera
     *  change. Zoom/pan pay zero geometry math, only rasterization. Sizes
     *  are WORLD UNITS straight from the settings (the 2026-09-15 pivot —
     *  no ÷kFit: the world scale is canonical, viewport-independent). */
    private buildGeometry;
    /** (Re)create the live sim from data.nodes at their current
     *  positions + the current physics tuning. Called by setData and
     *  setPhysicsTuning. */
    private buildSim;
    /** Rasterize cluster regions into the low-res world-space bitmap.
     *  Runs on data/visibility/settings changes at rest, and every
     *  REGION_EVERY-th frame while the live sim moves nodes (the in-between
     *  frames blit the previous bitmap — one sim step of staleness at
     *  120fps is invisible). Positions come straight from data.nodes. */
    private buildRegions;
    /** THE draw function: every layer, one frame, one camera. All drawing
     *  happens in WORLD coordinates under the camera transform; nothing is
     *  recomputed per frame except layer styling. */
    private draw;
}
//# sourceMappingURL=graph-canvas.d.ts.map