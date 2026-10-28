"use client";

/**
 * The hand-rolled single-canvas graph renderer (decided 2026-09-13 after
 * the research pass — docs/research/graph-rendering.md, Option B).
 *
 * Replaces sigma.js. Why: sigma gave us WebGL node/edge rendering,
 * picking, and a camera, but our cluster regions had to live on foreign
 * canvases injected next to its private DOM stack, drawn from a separate
 * event loop — so hulls lagged behind nodes during pan, raced sigma's
 * canvas sizing on renderer rebuilds, and every camera event re-rasterized
 * the full hull canvas (GPU spikes + audible coil whine). At our scale
 * (338 → low thousands of nodes) one Canvas 2D is comfortably inside
 * 60fps territory, and a single loop makes the desync class of bugs
 * structurally impossible.
 *
 * Architecture (the canonical pattern — browser.engineering, MDN
 *   "Optimizing canvas", web.dev canvas performance):
 *   - The renderer is a DUMB DRAW FUNCTION over plain data: nodes with
 *     world-space positions and a draw style (fill colour, size, disc or
 *     ring, dimmed), edges, clusters, settings. The first layout and
 *     filtering happen OUTSIDE, in the React component; this module only
 *     runs the live physics.
 *   - ONE canvas, ONE requestAnimationFrame loop with a dirty flag. Input
 *     and DOM events only mutate state and mark dirty; the loop draws at
 *     most once per frame with every layer under the same camera —
 *     hull fills → hull strokes → edges → nodes → region labels → node
 *     labels → hover. Nothing can ever lag anything else.
 *   - Camera: d3-zoom supplies the verified pan / zoom-to-cursor / pinch
 *     math (screen = world·k + [x,y]). The camera lives in the renderer
 *     instance, so data refetches and settings changes never move it.
 *   - Picking: nearest-node distance check (µs at our scale), with a
 *     PICKING_PAD so the whole hover halo is hit-testable.
 *
 * Zoom-gated labels (the Obsidian text-fade feel): sigma's camera "ratio"
 * convention is kept for the settings' persisted semantics — ratio 1 =
 * fit zoom, SMALLER = zoomed in (ratio = kFit / k). Node labels are
 * fully visible at ratio ≤ labelZoom and fade out across a span
 * proportional to the gate (LABELS_FADE_RATIO)
 * of ratio; cluster labels fade in over the exact same span (sums to 1)
 * so the two never coexist. All labels gate together — no per-node
 * popping.
 *
 * The hover glow is unchanged in look: a soft halo in the node's own
 * color at a constant radius, opacity cross-faded over ~180ms, with the
 * name brightening on the SAME factor. Only opacity animates; the only
 * per-frame work when idle is a dirty-flag check (no rAF is scheduled at
 * all until something changes).
 *
 * Unit tests cover the pure helpers (tests/graph-canvas.test.ts); the
 * class itself is DOM-bound and exercised live. Module scope stays
 * DOM-free so the file imports cleanly under Node.
 */

import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { buildDepDrawList, type DepArrow, type DepRouteSelection } from "../src/core/dep-draw-list.ts";
import { DEP_COLORS, DEP_STYLE, DEP_SPRING_STRENGTH, ROUTE_DONE_COLOR } from "../src/core/dep-palette.ts";
import type { Simulation, SimulationLinkDatum } from "d3-force";
import type { Pt } from "./cluster-geometry.ts";
import {
	CHARGE_STRENGTH,
	CLUSTER_PULL_STRENGTH,
	createGraphSimulation,
	routeFilteredEdges,
	routeDepSprings,
	routeLinkSet,
	routeLineForce,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	sanitizePhysicsTuning,
	sanitizeRegionTuning,
	type PhysicsTuning,
	type RegionTuning,
	INCREMENTAL_GRAVITY,
	type LayoutEdge,
	LINK_DISTANCE,
	type DepthAnchorMode,
	type GraphRenderSettings,
	type LayoutNode,
	type Position,
} from "@/src/core";

export type { GraphRenderSettings };

// ─── Public data contract ──────────────────────────────────────────────────

/** One node to draw: world-space position, the short glanceable label and
 *  the draw style (src/core/kb-graph-model.ts nodeStyle / domain colour). */
export interface CanvasNode {
	id: string;
	x: number;
	y: number;
	label: string;
	/** Fill / outline colour, "#rrggbb" (the node's domain hue). */
	color?: string;
	/** Radius multiplier over the nodeSize setting (default 1). */
	radius?: number;
	/** "disc" = filled, "ring" = hollow outline (default disc). */
	shape?: "disc" | "ring";
	/** Ring outline weight as a fraction of the radius. */
	ring?: number;
	/** Drawn faded. */
	dim?: boolean;
	/** Multiplier on the labelZoom gate: below 1 the label shows only after
	 *  zooming further in (default 1). */
	labelGate?: number;
	/** Work with an unshipped prerequisite: drawn with an outer ring. */
	blocked?: boolean;
}

/** One undirected-looking edge (no arrowheads; direction is irrelevant on
 *  the canvas). `faint` edges (related / wikilink) draw lighter. */
export interface CanvasEdge {
	from: string;
	to: string;
	faint?: boolean;
}

/** One cluster region: member node ids, its label (or null) and its tint
 *  ("#rrggbb", the domain hue). */
export interface CanvasCluster {
	id: string;
	label: string | null;
	members: string[];
	color: string;
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
	/** Dependency edges, prerequisite -> dependent: arrows drawn only when
	 *  zoomed into a Factory region (see buildDepDrawList). */
	depEdges?: CanvasEdge[];
	/** Dependency edges inside one Factory: weak layout springs. */
	depSprings?: CanvasEdge[];
	/** Per work-link rest lengths (`from|to`); links not in it use the uniform distance. */
	linkLengths?: ReadonlyMap<string, number>;
	/** Hierarchy depth per node id, for the depth anchoring (domain 0 →
	 *  section → entry → work). Absent = no anchoring. */
	depths?: ReadonlyMap<string, number>;
	clusters: CanvasCluster[];
	/** Nested sub-halos (the Factory subtree), painted over the cluster
	 *  regions in the same bitmap; no labels, no layout pull. */
	subClusters?: CanvasCluster[];
	colors: CanvasColors;
	/** Body font family (labels must match the app typography). */
	fontFamily: string;
}

export interface RendererCallbacks {
	/** A node was clicked (screen position included for card anchoring). */
	onSelect: (nodeId: string, screenPos: Pt) => void;
	/** The empty stage was clicked. */
	onStageClick: () => void;
	/** A node was double-clicked. */
	onNodeDoubleClick?: (nodeId: string) => void;
	/** Any camera move (pan/zoom) — the caller dismisses anchored UI and
	 *  persists the camera (view state). */
	onCameraMove: (transform: { k: number; x: number; y: number }) => void;
	/** The live sim settled after a drag: commit the new rest state
	 *  (the caller PUTs it to the positions store). */
	onCommit: (positions: Record<string, Position>) => void;
}

// ─── Constants (ported verbatim from the sigma view) ────────────────────────

const LABEL_SIZE = 12; // the reference label size the wrap-width ratio is taken against
const LABEL_WEIGHT = "500";

/** Region (cluster) labels — wave 7's session names made the labels
 *  LONG: imported-file paths and renamed chat titles. They wrap at a
 *  screen-fixed width (the labels are viewer-relative — this px value
 *  is exact on screen at any zoom), capped at a line count with an
 *  ellipsis on the last line (owner, 2026-09-23: wrap, cap 2–3 lines,
 *  ellipsize — a bounded footprint that keeps most of the path
 *  visible). */
const REGION_LABEL_MAX_WIDTH = 220; // screen px
const REGION_LABEL_MAX_LINES = 3;
const REGION_LABEL_LINE_HEIGHT = 1.3;

/** Wrap one region label: word-wise first (session names), then
 *  char-wise for words alone wider than the max (long file paths — the
 *  node-label discipline), capped at maxLines. Overflow folds into the
 *  last line, ellipsized to fit. measure is the canvas measureText (or a
 *  fake in tests) — pure otherwise. */
export function wrapRegionLabel(
	text: string,
	maxWidth: number,
	maxLines: number,
	measure: (s: string) => number,
): string[] {
	if (maxLines < 1) return [text];
	if (measure(text) <= maxWidth) return [text];
	const lines: string[] = [];
	const pending: string[] = text.split(/\s+/).filter(Boolean);
	// Fill up to maxLines-1 lines; the remainder becomes the last line.
	while (pending.length > 0 && lines.length < maxLines - 1) {
		let line = "";
		while (pending.length > 0) {
			let word = pending[0]!;
			const candidate = line ? `${line} ${word}` : word;
			if (measure(candidate) <= maxWidth) {
				line = candidate;
				pending.shift();
				continue;
			}
			if (!line) {
				// The word alone overflows: char-split it, the remainder stays
				// pending for the next line (paths have no spaces to help).
				let chunk = "";
				while (word.length > 0 && measure(chunk + word[0]) <= maxWidth) {
					chunk += word[0];
					word = word.slice(1);
				}
				if (chunk) {
					lines.push(chunk);
					pending[0] = word;
				} else {
					// Degenerate: one char exceeds the width — keep it whole so
					// the label can never vanish entirely.
					lines.push(word);
					pending.shift();
				}
				line = "";
			}
			break;
		}
		if (line) lines.push(line);
		if (!line && lines.length > 0 && pending.length > 0) continue;
		if (!line && lines.length === 0) break;
	}
	// The remainder rides as the last line: plain if it fits, ellipsized
	// down to the width if not.
	let rest = pending.join(" ");
	if (!rest) return lines;
	if (measure(rest) <= maxWidth) {
		lines.push(rest);
		return lines;
	}
	let tail = rest;
	while (tail.length > 1 && measure(`${tail}…`) > maxWidth) tail = tail.slice(0, -1);
	lines.push(`${tail}…`);
	return lines;
}

const LABEL_MAX_WIDTH = 170; // wrap width at the reference label size, world units
const LABEL_GAP = 2.9; // world units between node edge and first label line (the 2px-at-fit reference ÷ 0.69)
const LABEL_LINE_HEIGHT = 1.3;
/** The node→cluster label cross-fade spans gate × this (camera-ratio
 *  units) — PROPORTIONAL since 2026-09-17. The old absolute span (0.5
 *  ratio) read as a 100% relative change at the old 0.5 gate but a bare
 *  12% sliver at the tuned 8x gate (ratio 4): "lower zoom levels naturally
 *  produce a longer transitionary period while higher ones are more
 *  abrupt" — the user's exact observation. Proportional keeps ONE
 *  transitionary feel at any gate; at the 8x default the handoff fades
 *  across a full stop (8x → 12x). */
export const LABELS_FADE_RATIO = 0.5;

const GLOW_SCALE = 1.7; // halo outer radius = node radius x this (proportional, like blurring a copy of the disc)
const GLOW_ALPHA = 0.3; // halo opacity at the disc edge, fading outward
const PULSE_MS = 2000; // default activity-pulse length
const PULSE_REDUCED_MS = 800; // static-halo length under reduced motion
const HOVER_FADE_MS = 180; // hover halo opacity fade length
const ZOOM_EASE_MS = 45; // wheel-zoom glide: exponential-ease time constant (~250ms per notch)

/** Extra pickable radius (px) beyond the disc — the whole halo is
 *  hit-testable (the old flicker fix, minus the picking shader). */
const PICKING_PAD = 10;

/** Click vs drag threshold: pointer travel under this many px is a click. */
export const CLICK_SLOP = 4;
/** Live-sim tuning — see the class doc comment. */
const LIVE_ALPHA_DECAY = 0.05; // snappier anneal than the settle's 0.0228
const DRAG_ALPHA_TARGET = 0.3; // d3-drag's own reheat constant
const SIM_SETTLE_ALPHA = 0.005; // below this, the sim counts as settled
const ROUTE_REHEAT_ALPHA = 0.3; // gentle reheat on route select/deselect (a drag's own level)
const REST_DIM = 0.3; // the rest of the map while a route is selected
const COMMIT_DEBOUNCE_MS = 250; // settle → ledger PUT delay (new drags cancel)

/** Cluster region styling — a low-res world-space SPLAT bitmap (the
 *  density-field technique, Canvas-2D edition): every member node paints
 *  a soft radial-gradient disc and every intra-cluster edge a round-cap
 *  stroke; upscaling the bitmap with bilinear smoothing IS the blur.
 *  Replaces the convex-hull fills + borders: concave cluster shapes are
 *  finally correct (the hull bridged every gap with straight lines —
 *  the jagged close-up look), there is no border to lag behind, and a
 *  live-physics frame pays one tiny blit instead of 32 clusters × 4
 *  offset polygons re-rasterized at DPR 2 (the old GPU coil-whine). */
const REGION_EVERY = 3; // live-sim frames: rebuild every Nth, blit the rest



/** One horizontal+vertical box-blur round over PREMULTIPLIED RGBA
 *  (Float32, stride 4, length w*h*4). Premultiplying first is what keeps
 *  the blur halo-free: blurring non-premultiplied RGB over varying alpha
 *  bleeds solid color into transparent space. Pure: DOM-free, tested. */
export function boxBlurRound(
	src: Float32Array,
	tmp: Float32Array,
	dst: Float32Array,
	w: number,
	h: number,
	radius: number,
): void {
	if (radius <= 0) {
		dst.set(src);
		return;
	}
	const div = radius * 2 + 1;
	// Horizontal: src → tmp (clamped window, running sum).
	for (let y = 0; y < h; y++) {
		const row = y * w * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let x = -radius; x <= radius; x++) {
			const i = row + Math.min(Math.max(x, 0), w - 1) * 4;
			sum0 += src[i]!;
			sum1 += src[i + 1]!;
			sum2 += src[i + 2]!;
			sum3 += src[i + 3]!;
		}
		for (let x = 0; x < w; x++) {
			const o = row + x * 4;
			tmp[o] = sum0 / div;
			tmp[o + 1] = sum1 / div;
			tmp[o + 2] = sum2 / div;
			tmp[o + 3] = sum3 / div;
			const addI = row + Math.min(x + radius + 1, w - 1) * 4;
			const subI = row + Math.max(x - radius, 0) * 4;
			sum0 += src[addI]! - src[subI]!;
			sum1 += src[addI + 1]! - src[subI + 1]!;
			sum2 += src[addI + 2]! - src[subI + 2]!;
			sum3 += src[addI + 3]! - src[subI + 3]!;
		}
	}
	// Vertical: tmp → dst.
	for (let x = 0; x < w; x++) {
		const col = x * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let y = -radius; y <= radius; y++) {
			const i = col + Math.min(Math.max(y, 0), h - 1) * w * 4;
			sum0 += tmp[i]!;
			sum1 += tmp[i + 1]!;
			sum2 += tmp[i + 2]!;
			sum3 += tmp[i + 3]!;
		}
		for (let y = 0; y < h; y++) {
			const o = col + y * w * 4;
			dst[o] = sum0 / div;
			dst[o + 1] = sum1 / div;
			dst[o + 2] = sum2 / div;
			dst[o + 3] = sum3 / div;
			const addI = col + Math.min(y + radius + 1, h - 1) * w * 4;
			const subI = col + Math.max(y - radius, 0) * w * 4;
			sum0 += tmp[addI]! - tmp[subI]!;
			sum1 += tmp[addI + 1]! - tmp[subI + 1]!;
			sum2 += tmp[addI + 2]! - tmp[subI + 2]!;
			sum3 += tmp[addI + 3]! - tmp[subI + 3]!;
		}
	}
}

/** Geometry constants are WORLD UNITS (the 2026-09-15 pivot): node/
 *  label sizes come from the settings directly — the same law
 *  as linkDistance — so the world scale is canonical and never depends on
 *  the graph's extent or the viewport. Camera zoom scales them with the
 *  graph (Obsidian-style); edge widths and hull borders stay
 *  viewer-relative hairlines (÷ k); cluster labels stay screen-fixed
 *  (px at any zoom). kFit survives ONLY as the label-gate's "1×"
 *  reference (zoomRatioOf) — a pure LOD threshold, no geometry reads it. */

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

/**
 * The sigma-compatible "camera ratio": 1 at fit zoom, SMALLER when zoomed
 * in (ratio = kFit / k). The persisted labelZoom setting is denominated in
 * these units, so the gate semantics survive the renderer swap unchanged.
 */
export function zoomRatioOf(kFit: number, k: number): number {
	return kFit / k;
}

/**
 * Node-label opacity at a given camera ratio: 1 at/below the labelZoom
 * threshold, fading to 0 across a span of labelZoom x LABELS_FADE_RATIO
 * (see there). Cluster labels use `1 - this` over the same span — the
 * two cross-fade and never coexist at full opacity.
 */
export function labelAlpha(
	ratio: number,
	labelZoom: number,
	span = labelZoom * LABELS_FADE_RATIO,
): number {
	return clamp01(1 - (ratio - labelZoom) / span);
}

/** The camera transform that frames `bbox` in a w×h viewport with padding. */
export function fitTransform(
	bbox: { minX: number; maxX: number; minY: number; maxY: number },
	w: number,
	h: number,
	padding: number,
): { x: number; y: number; k: number } {
	const bw = Math.max(bbox.maxX - bbox.minX, 1e-6);
	const bh = Math.max(bbox.maxY - bbox.minY, 1e-6);
	const k = Math.min((w - 2 * padding) / bw, (h - 2 * padding) / bh);
	const cx = (bbox.minX + bbox.maxX) / 2;
	const cy = (bbox.minY + bbox.maxY) / 2;
	return { x: w / 2 - cx * k, y: h / 2 - cy * k, k };
}

/** The line segment for an edge a—b, trimmed to clear both node discs
 *  (so hollow ring nodes stay hollow). Null for coincident endpoints. */
export function edgeGeometry(a: Pt, b: Pt, fromRadius: number, toRadius: number): { from: Pt; to: Pt } | null {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) return null; // degenerate (coincident) — skip
	// Discs overlapping or touching leave no visible segment.
	if (len <= fromRadius + toRadius) return null;
	const ux = dx / len;
	const uy = dy / len;
	return {
		from: { x: a.x + ux * fromRadius, y: a.y + uy * fromRadius },
		to: { x: b.x - ux * toRadius, y: b.y - uy * toRadius },
	};
}

/** Nearest node within maxDist of a screen point, measured from each
 *  node's DISC EDGE (optional `r`, screen px) so big nodes are easy to hit
 *  and small ones aren't shadowed (linear scan — µs at our scale; a
 *  spatial grid only earns its keep past ~10k nodes). */
export function pickNearest<T extends { id: string; x: number; y: number; r?: number }>(
	nodes: T[],
	px: number,
	py: number,
	maxDist: number,
): T | null {
	let best: T | null = null;
	let bestD = maxDist;
	for (const n of nodes) {
		const d = Math.max(Math.hypot(n.x - px, n.y - py) - (n.r ?? 0), 0);
		if (d < bestD) {
			bestD = d;
			best = n;
		}
	}
	return best;
}

// ─── Canvas text helpers (ported verbatim) ─────────────────────────────────

/** "#rrggbb" + alpha → "rgba(...)". */
function rgbaFromHex(hex: string, alpha: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Word-wrap for canvas text. Never truncates: overlong single words are
 *  hard-broken by character so no line ever exceeds maxWidth. */
function wrapLabel(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const last = lines.length > 0 ? lines[lines.length - 1]! : null;
		if (last !== null) {
			const joined = `${last} ${word}`;
			if (context.measureText(joined).width <= maxWidth) {
				lines[lines.length - 1] = joined;
				continue;
			}
		}
		let chunk = "";
		for (const char of word) {
			if (chunk && context.measureText(`${chunk}${char}`).width > maxWidth) {
				lines.push(chunk);
				chunk = char;
			} else {
				chunk += char;
			}
		}
		if (chunk) lines.push(chunk);
	}
	return lines;
}

/** World-unit sizes for the label pass, derived once per geometry build. */
interface WorldSizes {
	nodeR: number; // base node disc radius (multiplier 1), world units
	labelSize: number; // node label font, world units
	labelGap: number; // node edge → first label line, world units
}

/** The pre-wrapped node name, centered below the node in WORLD units —
 *  identical geometry at rest and on hover, so hover only changes the
 *  color, nothing jumps. Lines are wrapped once per geometry build, never
 *  per frame. */
function drawNameLines(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	lines: string[],
	world: WorldSizes,
	radius: number,
	color: string,
): void {
	context.fillStyle = color;
	context.textAlign = "center";
	context.textBaseline = "top";
	const firstTop = y + radius + world.labelGap;
	for (let i = 0; i < lines.length; i++) {
		context.fillText(lines[i]!, x, firstTop + i * world.labelSize * LABEL_LINE_HEIGHT);
	}
}

/** One batch of nodes that share a look: drawn with a single fill (disc)
 *  or stroke (ring). */
interface NodeGroup {
	color: string;
	/** Fill/stroke opacity (dimmed nodes draw faded). */
	alpha: number;
	/** 0 = filled disc; > 0 = ring outline width, world units. */
	lineWidth: number;
	path: Path2D;
}

/** Opacity of dimmed nodes (den topics, archived work) and their labels. */
const DIM_ALPHA = 0.4;
const DIM_LABEL_ALPHA = 0.6;
/** Faint (related / wikilink) edges draw at this fraction of the edge alpha. */
const FAINT_EDGE_ALPHA = 0.4;

/** Debounced "rest state" commit with a flush: schedule() restarts the
 *  delay, cancel() drops it, flush() runs it NOW if one is pending. Pure
 *  (timers injectable) so the flush-on-replace/destroy law is testable. */
export function createCommitScheduler(
	delayMs: number,
	run: () => void,
	timers: {
		set: (fn: () => void, ms: number) => unknown;
		clear: (h: unknown) => void;
	} = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
): { schedule(): void; cancel(): void; flush(): void; pending(): boolean } {
	let handle: unknown = null;
	return {
		schedule() {
			if (handle !== null) timers.clear(handle);
			handle = timers.set(() => {
				handle = null;
				run();
			}, delayMs);
		},
		cancel() {
			if (handle !== null) timers.clear(handle);
			handle = null;
		},
		flush() {
			if (handle === null) return;
			timers.clear(handle);
			handle = null;
			run();
		},
		pending: () => handle !== null,
	};
}

// ─── The renderer ───────────────────────────────────────────────────────────

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export class GraphCanvasRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private callbacks: RendererCallbacks;
	private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>;
	private transform: ZoomTransform = zoomIdentity;
	/** Set once the first fit happens; the camera then survives setData. */
	private hasFit = false;
	/** Last-synced CSS size — the resize anchor computes the world point
	 *  under the PRE-resize viewport center from these (ResizeObserver
	 *  callbacks already see the NEW size in clientWidth/Height). */
	private viewW = 0;
	private viewH = 0;
	/** The k that frames the whole graph — the label-gate's "1×". */
	private kFit = 1;
	/** World-space bounds of the current nodes — fit() and the resize-time
	 *  kFit refresh share it (computed once per setData, not per resize). */
	private worldBBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;

	private data: CanvasData | null = null;
	/** id -> node for the current data (avoids O(n^2) scans). */
	private nodeById = new Map<string, CanvasNode>();
	private settings: GraphRenderSettings | null = null;
	/** Effective visibility: the search filter minus route-hidden (collapsed) nodes. */
	private visible: ReadonlySet<string> | null = null;
	private searchVisible: ReadonlySet<string> | null = null;

	// ── Live physics ──
	// One d3-force sim shared with the server settle (createGraphSimulation
	// in @/src/core): dragging pins fx/fy and reheats (alphaTarget), release
	// un-pins and the sim anneals; once alpha drops below SIM_SETTLE_ALPHA
	// the new rest state is debounced-committed via onCommit. The sim mutates
	// data.nodes IN PLACE (they ARE the sim nodes — zero copying), so every
	// tick just bumps geoVersion and the draw loop rebuilds geometry.
	private sim: Simulation<LayoutNode, SimulationLinkDatum<LayoutNode>> | null = null;
	private simById = new Map<string, LayoutNode>();
	private simActive = false;
	private dragId: string | null = null;
	private dragOrigin: Pt | null = null;
	/** The press passed the click slop (a real drag, not a click). */
	private dragMoved = false;
	private simMoved = false; // any real movement since the last commit
	private commit = createCommitScheduler(COMMIT_DEBOUNCE_MS, () => this.commitNow());

	private frameId: number | null = null;
	private dirty = true;
	/** True while tick() runs: markDirty inside the loop (d3's zoom event
	 *  fires from advanceZoom) must NOT schedule — the loop schedules
	 *  itself below. Un-guarded, each glide frame leaked an extra queued
	 *  tick and draws multiplied per displayed frame (20fps zoom bug). */
	private inTick = false;

	// Hover transition: fade 0 = resting, 1 = fully hovered; the animating
	// flag keeps the loop scheduled until the fade settles (then rAF stops).
	private hoverId: string | null = null;
	/** The node the glow is drawn on. OUTLIVES hoverId on hover-out so the
	 *  fade has something to draw (hoverId nulls instantly; without this
	 *  the glow popped off in one frame instead of fading). Cleared when
	 *  the outgoing fade completes. */
	private hoverNode: CanvasNode | null = null;
	private hoverFade = 0;
	private hoverFrom = 0;
	private hoverTarget = 0;
	private hoverStart = 0;
	/** Live-activity pulses: node id → start time, length, and whether
	 *  reduced motion was on when it began (static halo, short fixed time,
	 *  no rAF loop). Animated ones keep the loop running until they expire. */
	private pulses = new Map<string, { start: number; ms: number; reduce: boolean }>();
	// Smooth wheel zoom: wheel events accumulate a target scale (cursor-
	// anchored); each tick eases the camera toward it instead of jumping.
	private zoomTarget: { k: number; x: number; y: number } | null = null;
	/** Clock for frame-rate-independent easing (updated every tick). */
	private lastTickAt = 0;
	private animating = false;

	private resizeObserver: ResizeObserver;
	private downPos: Pt | null = null;

	// ── Cached world geometry ─────────────────────────────────────────────
	// Everything above is drawn per frame; everything below is derived from
	// data+visibility+settings+kFit and rebuilt ONLY when one of those
	// changes (geoVersion). Camera moves just re-rasterize the same paths.
	private geoVersion = 0; // bump = geometry inputs changed
	private builtVersion = -1; // version the cache was built at
	/** Node paths grouped by look (colour × disc/ring × dim × outline), so a
	 *  frame is one fill/stroke per group, not per node. */
	private nodeGroups: NodeGroup[] = [];
	private route: DepRouteSelection | null = null;
	/** Route selection: while set, the rest of the map is dimmed and the SAME
	 *  sim runs on a different link set (`simEdges`: route members' hierarchy
	 *  links dropped, route edges added) plus the weak route line force.
	 *  `edges` are the hierarchy edges drawn. */
	private straighten: { key: string; members: ReadonlySet<string>; edges: CanvasEdge[]; simEdges: LayoutEdge[]; depSprings: CanvasEdge[] } | null = null;
	private shaftsPath: Path2D = new Path2D();
	private faintShaftsPath: Path2D = new Path2D();
	private geometryReady = false;
	private regionCanvas: HTMLCanvasElement | null = null;
	/** World rect the bitmap covers (drawImage target coords). */
	private regionRect: { minX: number; minY: number; w: number; h: number } | null = null;
	/** Region labels: cluster centroid + hue, computed at splat build. */
	private regionMeta: { id: string; label: string | null; lines: string[] | null; cx: number; cy: number; color: string }[] = [];
	private regionTuning: RegionTuning = DEFAULT_REGION_TUNING;
	private physicsTuning: PhysicsTuning = DEFAULT_PHYSICS_TUNING;
	/** Gravity center for the live sim (graph bbox centroid at setData). */
	private simCenter: Pt = { x: 0, y: 0 };
	private regionBuiltVersion = -1;
	private frameCount = 0; // draw counter for the live-sim splat throttle
	private labelLines = new Map<string, string[]>();
	private worldLabelFont = "";
	private world: WorldSizes = { nodeR: 0, labelSize: 0, labelGap: 0 };

	constructor(
		canvas: HTMLCanvasElement,
		callbacks: RendererCallbacks,
		/** The caller's persisted camera (view state — localStorage): when
		 *  present it REPLACES the first-open fit; the graph opens exactly
		 *  where the user left it (2026-09-15: a default zoom exists only
		 *  on first open, ever). Invalid shapes fall back to fit. */
		initialCamera?: { k: number; x: number; y: number } | null,
	) {
		this.canvas = canvas;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("2d context unavailable");
		this.ctx = ctx;
		this.callbacks = callbacks;

		// d3-zoom owns pan / wheel zoom-to-cursor / touch pinch; every
		// transform change just marks dirty (draws happen in OUR loop).
		this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
			.scaleExtent([0.02, 40])
			.on("zoom", ({ transform }) => {
				this.transform = transform;
				this.markDirty();
				// The transform doubles as the persistence payload (view state).
				this.callbacks.onCameraMove(transform);
			});
		select(canvas)
			.call(this.zoomBehavior)
			// No surprise dblclick-zoom (sigma had none).
			.on("dblclick.zoom", null)
			// Wheel is OURS now: d3's instant per-notch jump felt janky; the
			// eased glide below replaces it (pan and pinch stay d3's).
			.on("wheel.zoom", null);

		canvas.addEventListener("wheel", this.onWheel, { passive: false });
		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointerleave", this.onPointerLeave);
		canvas.addEventListener("dblclick", this.onDoubleClick);
		// The native menu on a full-bleed custom canvas is never useful.
		canvas.addEventListener("contextmenu", this.onContextMenu);

		// The persisted camera: replace the default with wherever the user
		// left the graph. Applied through the zoom behavior so d3's internal
		// state and ours agree (the same path fit() uses); hasFit so neither
		// the ResizeObserver nor setData re-fits over it.
		if (
			initialCamera &&
			typeof initialCamera.k === "number" && Number.isFinite(initialCamera.k) && initialCamera.k > 0 &&
			typeof initialCamera.x === "number" && Number.isFinite(initialCamera.x) &&
			typeof initialCamera.y === "number" && Number.isFinite(initialCamera.y)
		) {
			this.hasFit = true;
			select(canvas).call(
				this.zoomBehavior.transform,
				zoomIdentity.translate(initialCamera.x, initialCamera.y).scale(initialCamera.k),
			);
		}

		this.resizeObserver = new ResizeObserver(() => {
			// The world point under the pre-resize viewport center — the
			// visual anchor the new transform must preserve. Capture it
			// BEFORE syncSize (which updates viewW/H to the new size).
			const prevW = this.viewW;
			const prevH = this.viewH;
			const { x: tx, y: ty, k } = this.transform;
			const wx = (prevW / 2 - tx) / k;
			const wy = (prevH / 2 - ty) / k;
			this.syncSize();
			if (!this.hasFit) this.fit(); // first real size → fit once
			else {
				this.refreshFitZoom(); // the gate's "1×" is viewport-bound
				// Center-anchor (2026-09-17, owner): same world point under
				// the NEW center. Applied through the zoom behavior like every
				// camera move (d3 state, persistence, card-dismiss all agree).
				if (prevW > 0 && prevH > 0 && this.viewW > 0 && this.viewH > 0) {
					select(canvas).call(
						this.zoomBehavior.transform,
						zoomIdentity.translate(this.viewW / 2 - wx * k, this.viewH / 2 - wy * k).scale(k),
					);
				}
			}
			// Redraw SYNCHRONOUSLY: syncSize may have reallocated the backing
			// store (which clears the canvas), and during live window resizes
			// rAF is starved by relayout — a deferred draw would leave the
			// canvas blank for the whole drag (the resize-blanking bug).
			this.draw();
		});
		this.resizeObserver.observe(canvas);
		this.syncSize();
	}

	// ── Public API ──

	setData(data: CanvasData): void {
		// A rest state waiting out its debounce belongs to the OLD nodes:
		// commit it before they are replaced.
		this.flushCommit();
		this.data = data;
		this.nodeById = new Map(data.nodes.map((n) => [n.id, n]));
		this.refreshVisible();
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of data.nodes) {
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x > maxX) maxX = n.x;
			if (n.y > maxY) maxY = n.y;
		}
		this.worldBBox = { minX, maxX, minY, maxY };
		if (!this.hasFit && data.nodes.length > 0) this.fit();
		// The camera may be user-restored (constructor initialCamera) — the
		// gate's "1×" reference still needs the fresh bbox's fit zoom.
		else this.refreshFitZoom();
		// Rebuild the live sim around the fresh nodes. New data means the
		// server spoke (merge or refetch); any pending commit was flushed
		// above and the graph is at rest until the next drag.
		this.simActive = false;
		this.dragId = null;
		this.simMoved = false;
		this.simCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
		// Fresh nodes, fresh sim: re-apply the selected route's link set.
		this.straighten = null;
		this.buildSim();
		if (this.route) this.applyStraighten(this.route);
		this.geoVersion++; // new data → rebuild world geometry
		this.markDirty();
	}

	/** Flash the halo on these nodes for `ms`, fading out. Ids not in the
	 *  graph are ignored. Under prefers-reduced-motion the halo is static
	 *  for a short fixed time (PULSE_REDUCED_MS) instead of fading. Returns how many landed. */
	pulse(ids: readonly string[], ms = PULSE_MS): number {
		const now = performance.now();
		const reduce = prefersReducedMotion();
		const len = reduce ? PULSE_REDUCED_MS : ms;
		let n = 0;
		for (const id of ids) {
			if (!this.nodeById.has(id)) continue;
			this.pulses.set(id, { start: now, ms: len, reduce });
			n++;
		}
		if (n > 0) {
			this.markDirty();
			// Reduced motion draws once now and once at expiry; no loop.
			if (reduce) setTimeout(() => this.markDirty(), len + 16);
		}
		return n;
	}

	setSettings(settings: GraphRenderSettings): void {
		this.settings = settings;
		this.geoVersion++; // sizes/wrap width changed → rebuild geometry
		this.markDirty();
	}

	/** Region rendering tuning (the persisted settings feed it): invalid
	 *  values fall back to defaults. Forces a region bitmap rebuild. */
	setRegionTuning(input: Partial<RegionTuning>): void {
		this.regionTuning = sanitizeRegionTuning(input);
		this.regionBuiltVersion = -2; // never equals geoVersion → rebuild
		// Off switch turning off: drop the bitmap immediately so the
		// blit stops on the next frame — the rebuild itself skips all
		// compute (buildRegions).
		if (!this.regionTuning.enabled) {
			this.regionCanvas = null;
			this.regionRect = null;
		}
		this.markDirty();
	}

	/** Live-sim physics controls: rebuilds the sim from the CURRENT
	 *  node positions (same node objects — x/y and any drag pin fx/fy
	 *  survive; velocities restart clean, which reads as "re-relax with
	 *  the new feel"). A mid-settle change re-anneals, which is the
	 *  honest response to new physics. */
	setPhysicsTuning(input: Partial<PhysicsTuning>): void {
		this.physicsTuning = sanitizePhysicsTuning(input);
		this.buildSim();
		// Reheat: a tuning change re-anneals the layout from its current
		// state, so mode toggles (off/vertical/radial) visibly RE-FORM the
		// graph instead of waiting for the next drag. Mid-drag is safe —
		// buildSim preserved the pinned node's fx/fy.
		if (this.sim) {
			this.sim.alpha(1);
			this.simActive = true;
		}
		this.markDirty();
	}

	/** The selected dependency route (bright arrows, dimmed shipped nodes,
	 *  parallel highlight), or null for none. */
	setRoute(route: DepRouteSelection | null): void {
		this.route = route;
		this.refreshVisible();
		this.applyStraighten(route);
		this.markDirty();
	}

	/** Select (or clear) a route: swap the link set the sim runs on, add or
	 *  drop the route line force, and reheat gently so the map relaxes into
	 *  the new shape the way it does after a drag. Keyed by the route's shape:
	 *  stepping the cursor changes nothing here. No positions are touched. */
	private applyStraighten(route: DepRouteSelection | null): void {
		const layout = route?.layout;
		let key: string | null = null;
		if (route && layout && this.nodeById.has(layout.root) && this.nodeById.has(layout.target)) {
			key = `${layout.root}>${layout.target}:${layout.steps.map((st) => st.join(",")).join(";")}|${[...route.edges].join(",")}|${[...route.done].join(",")}|${[...(route.hidden ?? [])].join(",")}`;
		}
		if (key === (this.straighten?.key ?? null)) return;
		if (key && route && layout) {
			const members = new Set([...route.nodes].filter((id) => this.nodeById.has(id)));
			this.straighten = {
				key,
				members,
				edges: routeFilteredEdges(this.data!.edges, members),
				simEdges: routeLinkSet(this.data!.edges, members, route.edges, (id) => this.nodeById.has(id)),
				depSprings: routeDepSprings(this.data!.depSprings ?? [], route.nodes, route.edges),
			};
		} else {
			this.straighten = null;
		}
		// Same sim, different links (+ the line force); positions and any
		// drag pin carry over.
		this.buildSim();
		if (this.sim) {
			this.sim.alpha(Math.max(this.sim.alpha(), ROUTE_REHEAT_ALPHA));
			this.simActive = true;
			this.simMoved = true;
			this.commit.cancel();
		}
		this.geoVersion++;
	}

	/** Opacity factor of a node/edge outside the straightened route. */
	private restDim(id: string): number {
		return this.straighten && !this.straighten.members.has(id) ? REST_DIM : 1;
	}

	/** Search filter minus the route's hidden (collapsed-feature) tasks. */
	private refreshVisible(): void {
		const hidden = this.route?.hidden;
		if (!hidden || hidden.size === 0) {
			this.visible = this.searchVisible;
			return;
		}
		const base = this.searchVisible ?? (this.data ? this.data.nodes.map((n) => n.id) : []);
		this.visible = new Set([...base].filter((id) => !hidden.has(id)));
	}

	setVisible(visible: ReadonlySet<string> | null): void {
		this.searchVisible = visible;
		this.refreshVisible();
		this.geoVersion++; // member visibility changes hulls + paths
		this.markDirty();
	}

	/** Frame the whole graph (padding included). Keeps the camera on later
	 *  setData calls — call fit() only for an explicit re-frame (the
	 *  first-ever open; afterwards the caller-persisted camera wins). */
	fit(): void {
		if (!this.data || this.data.nodes.length === 0 || !this.worldBBox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return; // layout not ready yet; the ResizeObserver retries
		const t = fitTransform(this.worldBBox, w, h, 40);
		this.kFit = t.k;
		this.hasFit = true;
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(t.x, t.y).scale(t.k),
		);
	}

	/** Refresh the label-gate's "1×" reference from the current bbox +
	 *  viewport. kFit feeds ONLY zoomRatioOf now (the 2026-09-15 pivot
	 *  removed it from geometry) — so this never touches geoVersion. */
	private refreshFitZoom(): void {
		if (!this.worldBBox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w >= 10 && h >= 10) this.kFit = fitTransform(this.worldBBox, w, h, 40).k;
	}

	/** Current world positions of every node (the sim moves them in place),
	 *  so a refetch can hand the same layout back to setData. */
	positions(): Map<string, Position> {
		const out = new Map<string, Position>();
		for (const n of this.data?.nodes ?? []) out.set(n.id, { x: n.x, y: n.y });
		return out;
	}

	/** Screen position (canvas-relative px) of a node under the current
	 *  camera, or null when the node is unknown. */
	nodeScreenPos(id: string): Pt | null {
		const n = this.nodeById.get(id);
		if (!n) return null;
		const { x: tx, y: ty, k } = this.transform;
		return { x: n.x * k + tx, y: n.y * k + ty };
	}

	/** Move the camera to frame the given nodes (padding included, zoom
	 *  capped at maxK so a lone node isn't blown up). Applied through the
	 *  zoom behavior, so the camera callback fires like any move. Returns
	 *  false when none of the ids is a known, visible node. */
	focusOn(ids: readonly string[], maxK = 4): boolean {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return false;
		const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
		let any = false;
		for (const id of ids) {
			const n = this.nodeById.get(id);
			if (!n || (this.visible && !this.visible.has(id))) continue;
			any = true;
			box.minX = Math.min(box.minX, n.x);
			box.maxX = Math.max(box.maxX, n.x);
			box.minY = Math.min(box.minY, n.y);
			box.maxY = Math.max(box.maxY, n.y);
		}
		if (!any) return false;
		const t = fitTransform(box, w, h, 80);
		const k = Math.min(t.k, maxK);
		const cx = (box.minX + box.maxX) / 2;
		const cy = (box.minY + box.maxY) / 2;
		this.zoomTarget = null;
		select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity.translate(w / 2 - cx * k, h / 2 - cy * k).scale(k));
		return true;
	}

	/** Pan (keeping the zoom) so the node is on screen; no-op when it already
	 *  is. True when the camera moved. */
	panIntoView(id: string, margin = 60): boolean {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const p = this.nodeScreenPos(id);
		if (!p || w < 10 || h < 10) return false;
		if (p.x >= margin && p.x <= w - margin && p.y >= margin && p.y <= h - margin) return false;
		const { x, y, k } = this.transform;
		select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity.translate(x + w / 2 - p.x, y + h / 2 - p.y).scale(k));
		return true;
	}

	destroy(): void {
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		this.flushCommit();
		this.sim = null;
		this.simActive = false;
		this.dragId = null;
		this.resizeObserver.disconnect();
		select(this.canvas).on(".zoom", null);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("dblclick", this.onDoubleClick);
		this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
		this.canvas.removeEventListener("contextmenu", this.onContextMenu);
		this.canvas.style.cursor = "";
	}

	// ── Event handlers (state mutation only — never draw) ──

	/** Wheel: accumulate the zoom target; the camera GLIDES toward it in the
	 *  tick loop (cursor-anchored). Sensitivity formula is d3-zoom's own. */
	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002);
		const { x, y } = this.eventPos(e);
		const current = this.zoomTarget?.k ?? this.transform.k;
		// Must stay inside the zoomBehavior's scaleExtent [0.02, 40].
		const k = Math.min(Math.max(current * Math.exp(delta), 0.02), 40);
		this.zoomTarget = { k, x, y };
		// Fresh easing clock so the glide starts gentle, never half-done.
		this.lastTickAt = performance.now();
		this.markDirty();
	};

	private onPointerMove = (e: PointerEvent) => {
		const pos = this.eventPos(e);
		if (this.dragId) {
			const n = this.simById.get(this.dragId);
			if (n) {
				const moved =
					this.dragOrigin !== null &&
					Math.hypot(pos.x - this.dragOrigin.x, pos.y - this.dragOrigin.y) > CLICK_SLOP;
				if (moved && !this.dragMoved) {
					this.dragMoved = true;
					// First real movement: reheat and glue the node to the cursor.
					this.commit.cancel();
					this.sim?.alphaTarget(DRAG_ALPHA_TARGET);
					this.simActive = true;
					this.markDirty();
				}
				const { x: tx, y: ty, k } = this.transform;
				n.fx = (pos.x - tx) / k;
				n.fy = (pos.y - ty) / k;
			}
			return;
		}
		const node = this.pickAt(pos.x, pos.y);
		if ((node?.id ?? null) !== this.hoverId) this.setHover(node?.id ?? null);
		this.canvas.style.cursor = node ? "pointer" : "";
	};

	private onPointerDown = (e: PointerEvent) => {
		// Primary button only (owner, polish round): a right-press must not
		// pin the node — right-click belongs to the context menu alone, and
		// the right-pointerup must never read as a click (the detail card
		// used to open under the menu).
		if (e.button !== 0) return;
		const pos = this.eventPos(e);
		const node = this.pickAt(pos.x, pos.y);
		if (node && this.sim) {
			// Node press: pin the node (at ITS OWN position — the cursor
			// may be inside the pick pad, off-center). preventDefault kills
			// the compatibility mousedown, so d3-zoom never starts a pan.
			// Physics only reheats once the pointer exceeds CLICK_SLOP —
			// a plain click stays perfectly still.
			e.preventDefault();
			try {
				this.canvas.setPointerCapture(e.pointerId);
			} catch {
				/* capture is best-effort */
			}
			this.dragId = node.id;
			this.dragOrigin = pos;
			this.dragMoved = false;
			const n = this.simById.get(node.id);
			if (n) {
				n.fx = n.x;
				n.fy = n.y;
			}
			this.canvas.style.cursor = "grabbing";
			this.markDirty();
			return;
		}
		this.downPos = pos;
		this.zoomTarget = null; // a pan takes over — cancel any zoom glide
	};

	private onPointerUp = (e: PointerEvent) => {
		if (e.button !== 0) return; // right-click is context-menu territory
		// Node press ending: click (no slop) → select; drag → release-and-relax.
		if (this.dragId) {
			const id = this.dragId;
			this.dragId = null;
			this.dragOrigin = null;
			try {
				this.canvas.releasePointerCapture(e.pointerId);
			} catch {
				/* already released */
			}
			this.canvas.style.cursor = "";
			const n = this.simById.get(id);
			if (n) {
				n.fx = null;
				n.fy = null;
			}
			if (this.dragMoved) {
				// Real drag: the sim anneals to the new rest state; advanceSim
				// detects the settle and schedules the commit.
				this.sim?.alphaTarget(0);
				this.markDirty();
			} else {
				// Never heated: a plain click on the node.
				this.callbacks.onSelect(id, this.eventPos(e));
			}
			return;
		}
		if (!this.downPos) return;
		const pos = this.eventPos(e);
		const moved = Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y);
		this.downPos = null;
		if (moved > CLICK_SLOP) return; // that was a drag (pan), not a click
		const node = this.pickAt(pos.x, pos.y);
		if (node) this.callbacks.onSelect(node.id, pos);
		else this.callbacks.onStageClick();
	};

	private onDoubleClick = (e: MouseEvent) => {
		const pos = this.eventPos(e);
		const node = this.pickAt(pos.x, pos.y);
		if (node) this.callbacks.onNodeDoubleClick?.(node.id);
	};

	private onContextMenu = (e: MouseEvent) => {
		e.preventDefault();
	};

	private onPointerLeave = () => {
		if (this.dragId) return; // pointer capture keeps the drag alive
		this.downPos = null;
		this.setHover(null);
	};

	// ── Internals ──

	private eventPos(e: { clientX: number; clientY: number }): Pt {
		const rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private pickAt(px: number, py: number): CanvasNode | null {
		if (!this.data || !this.settings) return null;
		const { x: tx, y: ty, k } = this.transform;
		// Picking measures from each disc's edge: radius on screen is the
		// world radius × the camera zoom; the halo pad stays a constant
		// screen pad.
		const projected: { id: string; x: number; y: number; r: number }[] = [];
		for (const n of this.data.nodes) {
			if (this.visible && !this.visible.has(n.id)) continue;
			projected.push({ id: n.id, x: n.x * k + tx, y: n.y * k + ty, r: this.radiusOf(n) * k });
		}
		const hit = pickNearest(projected, px, py, PICKING_PAD);
		if (!hit) return null;
		return this.nodeById.get(hit.id) ?? null;
	}

	/** A node's disc radius in world units (nodeSize × its multiplier). */
	private radiusOf(n: CanvasNode): number {
		return (this.settings?.nodeSize ?? 0) * (n.radius ?? 1);
	}

	private setHover(nodeId: string | null): void {
		if (nodeId === this.hoverId && this.hoverTarget === (nodeId ? 1 : 0)) return;
		this.hoverId = nodeId;
		// Hover-out deliberately KEEPS hoverNode: the glow must fade out
		// from the last hovered node, not vanish with the id.
		if (nodeId) this.hoverNode = this.nodeById.get(nodeId) ?? null;
		// Rebase the animation from the CURRENT fade: rapid hover toggles
		// glide instead of snapping (ported from the sigma-era behavior).
		this.hoverFrom = this.hoverFade;
		this.hoverTarget = nodeId ? 1 : 0;
		this.hoverStart = performance.now();
		this.animating = true;
		this.markDirty();
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.frameId === null && !this.inTick) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	private tick(): void {
		this.inTick = true;
		try {
			const now = performance.now();
			// Clamp the dt: a long idle gap must not teleport the ease forward.
			const dt = Math.min(Math.max(now - this.lastTickAt, 8), 100);
			this.lastTickAt = now;
			const hoverAnim = this.advanceHover();
			const zoomAnim = this.advanceZoom(dt);
			const simAnim = this.advanceSim();
			this.draw();
			// Keep frames coming ONLY while an animation is in motion (hover
			// fade, zoom glide, or live physics); an idle graph schedules no
			// rAF at all.
			let pulseAnim = false;
			for (const p of this.pulses.values()) if (!p.reduce) pulseAnim = true;
			this.animating = hoverAnim || zoomAnim || simAnim || pulseAnim;
		} finally {
			this.inTick = false;
		}
		if (this.animating) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	/** One live-sim step; returns true while physics is still in motion.
	 *  Runs only while simActive (drag reheat or post-release anneal). */
	private advanceSim(): boolean {
		if (!this.sim || !this.simActive) return false;
		this.sim.tick();
		// Movement check: did any node actually move (a click-pin that
		// never reheated leaves everything exactly at rest)?
		for (const n of this.sim.nodes()) {
			if (n.vx || n.vy) {
				this.simMoved = true;
				break;
			}
		}
		this.geoVersion++; // positions changed → geometry rebuild in draw()
		// Settled (drag released long ago, alpha annealed away)?
		if (!this.dragId && this.sim.alpha() < SIM_SETTLE_ALPHA) {
			this.simActive = false;
			this.scheduleCommit();
			return false;
		}
		return true;
	}

	/** Debounced rest-state commit. A new drag cancels it; setData and
	 *  destroy FLUSH it so a settled arrangement is never lost. */
	private scheduleCommit(): void {
		this.commit.schedule();
	}

	private flushCommit(): void {
		this.commit.flush();
	}

	private commitNow(): void {
		if (!this.data || !this.simMoved) return;
		this.simMoved = false;
		const positions: Record<string, Position> = {};
		for (const n of this.data.nodes) positions[n.id] = { x: n.x, y: n.y };
		this.callbacks.onCommit(positions);
	}

	/** Hover fade step; returns true while still moving. */
	private advanceHover(): boolean {
		if (this.hoverFade === this.hoverTarget) return false;
		const t = Math.min((performance.now() - this.hoverStart) / HOVER_FADE_MS, 1);
		this.hoverFade = this.hoverFrom + (this.hoverTarget - this.hoverFrom) * t;
		// Outgoing fade finished — release the glow node.
		if (this.hoverTarget === 0 && this.hoverFade === 0) this.hoverNode = null;
		return t < 1;
	}

	/** Zoom glide step: ease k toward the wheel target, keeping the world
	 *  point under the cursor pinned. Frame-rate independent (exponential
	 *  approach, time constant ZOOM_EASE_MS). Returns true while gliding. */
	private advanceZoom(dt: number): boolean {
		const target = this.zoomTarget;
		if (!target) return false;
		const t = this.transform;
		const blend = 1 - Math.exp(-dt / ZOOM_EASE_MS);
		let k = t.k + (target.k - t.k) * blend;
		let done = false;
		if (Math.abs(target.k - k) / target.k < 0.002) {
			k = target.k;
			done = true;
		}
		const scale = k / t.k;
		const x = target.x - (target.x - t.x) * scale;
		const y = target.y - (target.y - t.y) * scale;
		if (done) this.zoomTarget = null;
		// Applied through d3-zoom so constraints + the zoom event (markDirty,
		// onCameraMove) fire exactly as with any other camera change.
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(x, y).scale(k),
		);
		return !done;
	}

	/** Resize the backing store to the CSS box × devicePixelRatio; all
	 *  drawing then happens in CSS pixels through the DPR transform. */
	private syncSize(): void {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const bw = Math.max(1, Math.round(w * dpr));
		const bh = Math.max(1, Math.round(h * dpr));
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
		}
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.viewW = w;
		this.viewH = h;
	}

	private drawDependencyLayer(ctx: CanvasRenderingContext2D, ratio: number, k: number, w: number, h: number): void {
		const data = this.data;
		if (!data) return;
		const visible = this.visible;
		const route = this.route;
		ctx.save();
		// Blocked rings (always on) and the route's node halos.
		for (const n of data.nodes) {
			if (visible && !visible.has(n.id)) continue;
			const r = this.radiusOf(n);
			if (n.blocked) {
				ctx.globalAlpha = n.dim ? DIM_ALPHA : 1;
				ctx.strokeStyle = DEP_COLORS.blockedRing;
				ctx.lineWidth = r * DEP_STYLE.blockedRingWeight;
				ctx.beginPath();
				ctx.arc(n.x, n.y, r * DEP_STYLE.blockedRingScale, 0, Math.PI * 2);
				ctx.stroke();
			}
			if (route && route.nodes.has(n.id)) {
				ctx.globalAlpha = route.done.has(n.id) ? DEP_STYLE.routeDoneNodeAlpha : 1;
				ctx.strokeStyle = route.done.has(n.id) ? ROUTE_DONE_COLOR : route.parallel.has(n.id) ? DEP_COLORS.parallel : DEP_COLORS.route;
				ctx.lineWidth = r * DEP_STYLE.haloWeight;
				ctx.beginPath();
				ctx.arc(n.x, n.y, r * DEP_STYLE.haloScale, 0, Math.PI * 2);
				ctx.stroke();
				if (route.cursor === n.id) {
					// The card's cursor: a second, wider and heavier ring.
					ctx.globalAlpha = 1;
					ctx.lineWidth = r * DEP_STYLE.haloWeight * 2.2;
					ctx.beginPath();
					ctx.arc(n.x, n.y, r * DEP_STYLE.haloScale * 1.35, 0, Math.PI * 2);
					ctx.stroke();
				}
			}
		}
		// "+N" badge on each collapsed feature (click the node to expand it).
		if (route?.collapsed?.size) {
			ctx.font = this.worldLabelFont;
			ctx.textAlign = "left";
			ctx.textBaseline = "middle";
			ctx.fillStyle = DEP_COLORS.route;
			ctx.globalAlpha = 1;
			for (const [id, count] of route.collapsed) {
				const n = this.nodeById.get(id);
				if (!n || (visible && !visible.has(id))) continue;
				const r = this.radiusOf(n);
				ctx.fillText(`+${count}`, n.x + r * DEP_STYLE.haloScale * 1.1, n.y - r * DEP_STYLE.haloScale);
			}
		}
		// Arrows.
		const positions = new Map<string, { x: number; y: number }>();
		for (const n of data.nodes) positions.set(n.id, n);
		const { x: tx, y: ty } = this.transform;
		const list = buildDepDrawList({
			edges: data.depEdges ?? [],
			factories: data.subClusters ?? [],
			positions,
			viewport: { minX: -tx / k, minY: -ty / k, maxX: (w - tx) / k, maxY: (h - ty) / k },
			ratio,
			visible,
			route,
		});
		const head = DEP_STYLE.headLength / k;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		const stroke = (a: DepArrow): void => {
			const from = this.nodeById.get(a.from);
			const to = this.nodeById.get(a.to);
			if (!from || !to) return;
			const g = edgeGeometry(from, to, this.radiusOf(from), this.radiusOf(to));
			if (!g) return;
			const color = !a.bright ? DEP_COLORS.faintDep : a.done ? ROUTE_DONE_COLOR : a.parallel ? DEP_COLORS.parallel : DEP_COLORS.route;
			ctx.globalAlpha = a.bright ? 1 : DEP_STYLE.faintAlpha;
			ctx.strokeStyle = color;
			ctx.fillStyle = color;
			ctx.lineWidth = (a.done ? DEP_STYLE.doneWidth : a.bright ? DEP_STYLE.routeWidth : DEP_STYLE.faintWidth) / k;
			ctx.beginPath();
			ctx.moveTo(g.from.x, g.from.y);
			ctx.lineTo(g.to.x, g.to.y);
			ctx.stroke();
			const ang = Math.atan2(g.to.y - g.from.y, g.to.x - g.from.x);
			ctx.beginPath();
			ctx.moveTo(g.to.x, g.to.y);
			ctx.lineTo(g.to.x - head * Math.cos(ang - 0.4), g.to.y - head * Math.sin(ang - 0.4));
			ctx.lineTo(g.to.x - head * Math.cos(ang + 0.4), g.to.y - head * Math.sin(ang + 0.4));
			ctx.closePath();
			ctx.fill();
		};
		for (const a of list.arrows) stroke(a);
		ctx.restore();
	}

	/** Derive ALL world geometry from data + visibility + settings.
	 *  Runs only when geoVersion moves — never per frame, never per camera
	 *  change. Zoom/pan pay zero geometry math, only rasterization. Sizes
	 *  are WORLD UNITS straight from the settings (the 2026-09-15 pivot —
	 *  no ÷kFit: the world scale is canonical, viewport-independent). */
	private buildGeometry(): void {
		this.builtVersion = this.geoVersion;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;

		const nodeR = settings.nodeSize;
		this.worldLabelFont = `${LABEL_WEIGHT} ${settings.labelSize}px ${data.fontFamily}`;
		this.world = {
			nodeR,
			labelSize: settings.labelSize,
			labelGap: LABEL_GAP,
		};
		const visible = this.visible;
		const isVisible = (id: string) => !visible || visible.has(id);

		// Node discs and rings: one Path2D per look, one fill/stroke each
		// per frame. A ring is an arc stroked INSIDE its radius (outer edge
		// = the radius), so picking, edges and labels all see the same disc.
		const groups = new Map<string, NodeGroup>();
		for (const n of data.nodes) {
			if (!isVisible(n.id)) continue;
			const r = this.radiusOf(n);
			const ring = n.shape === "ring" ? Math.min(Math.max(n.ring ?? 0.25, 0.05), 1) * r : 0;
			const routeDone = !!this.route?.nodes.has(n.id) && this.route.done.has(n.id);
			const color = routeDone ? ROUTE_DONE_COLOR : (n.color ?? data.colors.node);
			const alpha = routeDone ? DEP_STYLE.routeDoneNodeAlpha : (n.dim ? DIM_ALPHA : 1) * this.restDim(n.id);
			const key = `${color}|${alpha}|${ring.toFixed(3)}`;
			let g = groups.get(key);
			if (!g) groups.set(key, (g = { color, alpha, lineWidth: ring, path: new Path2D() }));
			const arcR = ring > 0 ? r - ring / 2 : r;
			g.path.moveTo(n.x + arcR, n.y);
			g.path.arc(n.x, n.y, arcR, 0, Math.PI * 2);
		}
		this.nodeGroups = [...groups.values()];

		// Edges: plain line segments trimmed to clear both discs; faint
		// (related / wikilink) edges go in their own path to draw lighter.
		const shafts = new Path2D();
		const faintShafts = new Path2D();
		for (const e of this.straighten?.edges ?? data.edges) {
			if (!isVisible(e.from) || !isVisible(e.to)) continue;
			const a = this.nodeById.get(e.from);
			const b = this.nodeById.get(e.to);
			if (!a || !b) continue;
			const g = edgeGeometry(a, b, this.radiusOf(a), this.radiusOf(b));
			if (!g) continue;
			const path = e.faint ? faintShafts : shafts;
			path.moveTo(g.from.x, g.from.y);
			path.lineTo(g.to.x, g.to.y);
		}
		this.shaftsPath = shafts;
		this.faintShaftsPath = faintShafts;
		this.geometryReady = true;

		// Cluster regions are NOT built here: they rasterize into their own
		// low-res bitmap (see buildRegions), on their own rebuild schedule
		// (live-sim frames skip 2 of 3 rebuilds and blit the last bitmap).

		// Label wrapping: measureText once per node per geometry build,
		// never per frame. Wrap width keeps the bigger-label/bigger-wrap
		// behavior from the sigma era.
		this.labelLines = new Map();
		const ctx = this.ctx;
		const prevFont = ctx.font;
		ctx.font = this.worldLabelFont;
		const maxW = LABEL_MAX_WIDTH * (settings.labelSize / LABEL_SIZE);
		for (const n of data.nodes) {
			if (isVisible(n.id)) this.labelLines.set(n.id, wrapLabel(ctx, n.label, maxW));
		}
		ctx.font = prevFont;
	}

	/** (Re)create the live sim from data.nodes at their current
	 *  positions + the current physics tuning. Called by setData and
	 *  setPhysicsTuning. */
	private buildSim(): void {
		const data = this.data;
		if (!data || data.nodes.length === 0) {
			this.sim = null;
			this.simById = new Map();
			return;
		}
		const t = this.physicsTuning;
		const springs = this.straighten?.depSprings ?? data.depSprings ?? [];
		this.sim = createGraphSimulation(data.nodes, this.straighten?.simEdges ?? data.edges, {
			gravity: { x: this.simCenter.x, y: this.simCenter.y, strength: t.gravity },
			alphaDecay: LIVE_ALPHA_DECAY,
			velocityDecay: t.velocityDecay,
			chargeStrength: t.chargeStrength,
			linkStrength: t.linkStrength,
			linkDistance: t.linkDistance,
			linkLengths: data.linkLengths,
			depSprings: springs.length ? { edges: springs, strength: DEP_SPRING_STRENGTH } : undefined,
			clusterPull:
				data.clusters.length > 0 ? { clusters: data.clusters, strength: t.clusterPull } : undefined,
			depthAnchor:
				t.depthMode === "off" || !data.depths
					? undefined
					: {
							mode: t.depthMode,
							depths: data.depths,
							strength: t.depthStrength,
							spacing: t.depthSpacing,
							baseRadius: t.depthBaseRadius,
							center: this.simCenter,
						},
		});
		if (this.route?.layout && this.straighten) this.sim.force("routeLine", routeLineForce(this.route.layout));
		this.simById = new Map(data.nodes.map((n) => [n.id, n as LayoutNode]));
		// Hygiene (2026-09-23 fix wave): a fresh sim starts at alpha 1 and
		// never decays while stopped — so the first post-rebuild drag would
		// re-anneal the whole graph at full strength (alphaTarget(0.3)
		// glides DOWN from 1 instead of gently up from rest). Initialize at
		// the settle floor so first-drag behavior matches steady-state
		// drags. setPhysicsTuning still rehearses its explicit alpha(1)
		// when a full re-anneal IS the point.
		this.sim.alpha(SIM_SETTLE_ALPHA);
	}

	/** Rasterize cluster regions into the low-res world-space bitmap.
	 *  Runs on data/visibility/settings changes at rest, and every
	 *  REGION_EVERY-th frame while the live sim moves nodes (the in-between
	 *  frames blit the previous bitmap — one sim step of staleness at
	 *  120fps is invisible). Positions come straight from data.nodes. */
	private buildRegions(): void {
		const data = this.data;
		if (!data || data.clusters.length === 0) {
			this.regionCanvas = null;
			this.regionRect = null;
			this.regionMeta = [];
			return;
		}
		const visible = this.visible;
		const isVisible = (id: string): boolean => !visible || visible.has(id);

		const tuning = this.regionTuning;
		// Dilation is WORLD units (the 2026-09-15 pivot) — the region stroke
		// half-width comes straight from the setting, no kFit.

		// World rect over VISIBLE cluster members (regions cover members
		// and their intra-cluster edges — nothing else).
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const c of data.clusters) {
			for (const id of c.members) {
				if (!isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				if (n.x < minX) minX = n.x;
				if (n.x > maxX) maxX = n.x;
				if (n.y < minY) minY = n.y;
				if (n.y > maxY) maxY = n.y;
			}
		}
		if (minX > maxX) {
			this.regionCanvas = null;
			this.regionRect = null;
			this.regionMeta = [];
			return;
		}

		// Which cluster is a node in (for intra-cluster edges)?
		const clusterOf = new Map<string, number>();
		data.clusters.forEach((c, i) => {
			for (const id of c.members) clusterOf.set(id, i);
		});

		// Label anchors ALWAYS compute (cheap — a centroid pass, no canvas):
		// cluster labels follow their own `clusterLabels` setting and must
		// survive the region paint being turned off.
		this.regionMeta = [];
		data.clusters.forEach((cluster) => {
			let members = 0;
			let sumX = 0;
			let sumY = 0;
			for (const id of cluster.members) {
				if (!isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				members++;
				sumX += n.x;
				sumY += n.y;
			}
			if (members > 0) {
				this.regionMeta.push({
					id: cluster.id,
					label: cluster.label || null,
					cx: sumX / members,
					cy: sumY / members,
					color: cluster.color,
					lines: null,
				});
			}
		});

		// Wrap the region labels ONCE per geometry build, at their
		// SCREEN-fixed size (viewer-relative labels — this px size is what
		// lands on screen at any zoom, so the wrap never goes stale mid-
		// camera-move). Session names are short; file paths are not (wave
		// 7) — the cap + ellipsis keeps the footprint bounded.
		const settings = this.settings;
		if (settings) {
			const ctx = this.ctx;
			const prevFont = ctx.font;
			ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize}px ${data.fontFamily}`;
			for (const rm of this.regionMeta) {
				rm.lines = rm.label
					? wrapRegionLabel(rm.label, REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES, (s) => ctx.measureText(s).width)
					: null;
			}
			ctx.font = prevFont;
		}

		// THE off switch (user 2026-09-15): compute is skipped, not just
		// paint hidden — no splat, no blur, no readback, no bitmap, no
		// blit. Everything below this return is the bitmap path.
		if (!tuning.enabled) {
			this.regionCanvas = null;
			this.regionRect = null;
			return;
		}

		// Bitmap sizing: longest world span maps to `bitmap` px. The rect
		// is padded by the stroke half-width (dilation) plus the blur
		// reach so nothing clips at the bitmap edge.
		//
		// The blur reach is WORLD units (the 2026-09-15 pivot's last step):
		// tuning.blur IS the world reach, canonical like dilation — it no
		// longer scales with the graph's span (the old blurW = blur ×
		// span/bitmap read 6× softer on a 338-node graph than on a
		// 13-node one). This also makes the 2026-09-14 search-collapse fix
		// structural: a world-unit blur cannot be coupled to any cell, so
		// the old `cellRef` anchor is gone.
		const dilationW = tuning.dilation;
		const blurW = tuning.blur;
		const padWorld = dilationW + blurW * 2;
		// Cell floor: a single visible node (span 0) zeroed the cell and
		// blew the bitmap dims to Infinity (getImageData TypeError). The
		// floor is the padded rect's own reach, so dims stay finite (long
		// side ≤ bitmap · (1 + span/2·pad)) however tight the search.
		const spanNow = Math.max(maxX - minX, maxY - minY);
		const cell = Math.max(spanNow, padWorld * 2) / tuning.bitmap;
		minX -= padWorld;
		minY -= padWorld;
		maxX += padWorld;
		maxY += padWorld;
		const spanX = maxX - minX;
		const spanY = maxY - minY;
		const bw = Math.max(1, Math.ceil(spanX / cell));
		const bh = Math.max(1, Math.ceil(spanY / cell));
		let rc = this.regionCanvas;
		if (!rc) {
			rc = document.createElement("canvas");
			this.regionCanvas = rc;
		}
		if (rc.width !== bw || rc.height !== bh) {
			rc.width = bw;
			rc.height = bh; // also clears
		}
		// willReadFrequently: the blur step getImageData/putImageData every
		// rebuild — Chrome keeps this canvas on the CPU instead of GPU-
		// shuttling it.
		const rctx = rc.getContext("2d", { willReadFrequently: true });
		if (!rctx) return;
		rctx.clearRect(0, 0, bw, bh);
		rctx.lineCap = "round";
		rctx.lineWidth = (dilationW * 2) / cell;

		// The region IS the dilated skeleton: intra-cluster edges as
		// round-cap strokes (Minkowski dilation). NO blanket per-node discs
		// — they double-counted where nodes sit on edges (user-identified
		// hot spots, when clusters were edge-based).
		data.clusters.forEach((cluster, ci) => {
			const tint = cluster.color;
			// Full-opacity strokes: alpha is applied ONCE at the very end
			// (dilate at 1 → blur → scale by edgeAlpha). Baking per-stroke
			// alpha in here made source-over stacking ACCUMULATE it — an
			// orphan disc overlapping anything read as a darker double-
			// counted spot (user report 2026-09-14). At alpha 1 the alpha
			// channel is a pure coverage indicator: overlaps of any count
			// contribute exactly 1.0.
			rctx.strokeStyle = tint;
			rctx.beginPath();
			// Endpoints actually covered by a stroke's round caps.
			const touched = new Set<string>();
			for (const e of data.edges) {
				if (clusterOf.get(e.from) !== ci) continue;
				if (clusterOf.get(e.to) !== ci) continue;
				// Search filter: stroke only fully-visible edges. Invisible-node
				// segments still stroked into the (visible-only) bitmap cut
				// diagonal hue streaks across other clusters' regions (user-
				// reported 2026-09-14) — rect, discs, and anchors already filter.
				if (!isVisible(e.from) || !isVisible(e.to)) continue;
				const a = this.nodeById.get(e.from);
				const b = this.nodeById.get(e.to);
				if (!a || !b) continue;
				rctx.moveTo((a.x - minX) / cell, (a.y - minY) / cell);
				rctx.lineTo((b.x - minX) / cell, (b.y - minY) / cell);
				touched.add(e.from);
				touched.add(e.to);
			}
			rctx.stroke();

			// Member discs for the SEMANTIC era (DECIDED 2026-09-13): clusters
			// are now topics by meaning, and many members (orphans, isolated
			// micro-topics) share NO intra-cluster edge with anyone — edge
			// strokes alone left them completely uncolored. A disc (same
			// radius as a round cap = dilation) covers exactly the members no
			// stroke reached: every member is painted by its edges' caps OR
			// one disc, never both — the no-double-counting rule survives.
			rctx.fillStyle = tint;
			const discR = dilationW / cell;
			for (const id of cluster.members) {
				if (touched.has(id) || !isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				rctx.beginPath();
				rctx.arc((n.x - minX) / cell, (n.y - minY) / cell, discR, 0, Math.PI * 2);
				rctx.fill();
			}
		});

		// Nested sub-halos (Factory subtree): the same dilated-skeleton
		// stroke, painted OVER the domain regions in the same bitmap, so the
		// darker shade replaces the domain hue where they overlap and one
		// blur + alpha pass covers both.
		for (const sub of data.subClusters ?? []) {
			const inSub = new Set(sub.members);
			rctx.strokeStyle = sub.color;
			rctx.fillStyle = sub.color;
			rctx.beginPath();
			const touched = new Set<string>();
			for (const e of data.edges) {
				if (!inSub.has(e.from) || !inSub.has(e.to)) continue;
				if (!isVisible(e.from) || !isVisible(e.to)) continue;
				const a = this.nodeById.get(e.from);
				const b = this.nodeById.get(e.to);
				if (!a || !b) continue;
				rctx.moveTo((a.x - minX) / cell, (a.y - minY) / cell);
				rctx.lineTo((b.x - minX) / cell, (b.y - minY) / cell);
				touched.add(e.from);
				touched.add(e.to);
			}
			rctx.stroke();
			const discR = dilationW / cell;
			for (const id of sub.members) {
				if (touched.has(id) || !isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				rctx.beginPath();
				rctx.arc((n.x - minX) / cell, (n.y - minY) / cell, discR, 0, Math.PI * 2);
				rctx.fill();
			}
		}

		// THE blur + alpha (in that order, by design — user-decided
		// 2026-09-14): 3 box-blur rounds on the premultiplied bitmap,
		// THEN scale the whole field by edgeAlpha once. Bilinear
		// upscaling alone is no blur at all (tent ramps — the JPEG look);
		// this makes the field genuinely smooth before the blit. The
		// radius is the world reach ÷ cell, rounded to an integer
		// (boxBlurRound indexes with the loop counter) with a 1px floor —
		// a graph whose cell exceeds the blur reach still gets one pixel
		// of softening rather than aliasing to zero. Radius 0 (blur off)
		// still runs this path — boxBlurRound
		// copies — so the end-alpha applies uniformly with or without
		// blur.
		{
			const blurPx = tuning.blur > 0 ? Math.max(1, Math.round(blurW / cell)) : 0;
			const img = rctx.getImageData(0, 0, bw, bh);
			const n = bw * bh * 4;
			const a = new Float32Array(n);
			for (let i = 0; i < n; i += 4) {
				const alpha = img.data[i + 3]! / 255;
				a[i] = img.data[i]! * alpha;
				a[i + 1] = img.data[i + 1]! * alpha;
				a[i + 2] = img.data[i + 2]! * alpha;
				a[i + 3] = img.data[i + 3]!;
			}
			const b = new Float32Array(n);
			const tmp = new Float32Array(n); // scratch inside each round only
			boxBlurRound(a, tmp, b, bw, bh, blurPx); // a → b
			boxBlurRound(b, tmp, a, bw, bh, blurPx); // b → a
			boxBlurRound(a, tmp, b, bw, bh, blurPx); // a → b (result)
			// Unpremultiply back into pixels; scale the alpha by edgeAlpha
			// HERE — the one, final application. Result: constant interior
			// alpha everywhere covered, tapering only across the blur edges.
			for (let i = 0; i < n; i += 4) {
				const alpha = b[i + 3]!;
				if (alpha <= 0) {
					img.data[i] = 0;
					img.data[i + 1] = 0;
					img.data[i + 2] = 0;
					img.data[i + 3] = 0;
				} else {
					// Un-premultiply: pm = c * a/255, so c = pm / a * 255.
					img.data[i] = Math.round((b[i]! / alpha) * 255);
					img.data[i + 1] = Math.round((b[i + 1]! / alpha) * 255);
					img.data[i + 2] = Math.round((b[i + 2]! / alpha) * 255);
					img.data[i + 3] = Math.round(alpha * tuning.edgeAlpha);
				}
			}
			rctx.putImageData(img, 0, 0);
		}
		this.regionRect = { minX, minY, w: spanX, h: spanY };
	}

	/** THE draw function: every layer, one frame, one camera. All drawing
	 *  happens in WORLD coordinates under the camera transform; nothing is
	 *  recomputed per frame except layer styling. */
	private draw(): void {
		this.dirty = false;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const ctx = this.ctx;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		this.frameCount++;
		// Regions: rebuild on stale geometry at rest; during the live sim,
		// every REGION_EVERY-th frame (others blit the last bitmap).
		if (
			this.regionBuiltVersion !== this.geoVersion &&
			(!this.simActive || this.frameCount % REGION_EVERY === 0)
		) {
			this.buildRegions();
			this.regionBuiltVersion = this.geoVersion;
		}
		if (this.builtVersion !== this.geoVersion) this.buildGeometry();
		if (!this.geometryReady) return;

		const { x: tx, y: ty, k } = this.transform;
		// THE camera: one transform, then everything is world coordinates.
		ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);

		const ratio = zoomRatioOf(this.kFit, k);
		const nodeAlpha = labelAlpha(ratio, settings.labelZoom);
		const regionAlpha = 1 - nodeAlpha;

		// 1. Cluster regions: one tiny world-space bitmap blit. The upscale
		//    blur is the region softness; adjacent cluster tints blend
		//    source-over where they overlap (decided: multiply is invisible
		//    on the dark background).
		if (this.regionCanvas && this.regionRect) {
			const { minX, minY, w, h } = this.regionRect;
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(this.regionCanvas, minX, minY, w, h);
		}

		// 3. Edges: plain segments from cached paths; width constant on
		// screen (÷ k), geometry in world units (scales with the graph).
		// Faint edges (related / wikilink) draw lighter. A true 0-width
		// stroke is undefined on canvas: the ratio's 0 end floors to a
		// hairline (0.5px on screen).
		if (settings.edgeWidth > 0) {
			ctx.strokeStyle = data.colors.edge;
			ctx.lineWidth = settings.edgeWidth / k;
			ctx.lineCap = "round";
			const edgeDim = this.straighten ? REST_DIM : 1;
			ctx.save();
			ctx.globalAlpha = edgeDim;
			ctx.stroke(this.shaftsPath);
			ctx.globalAlpha = FAINT_EDGE_ALPHA * edgeDim;
			ctx.stroke(this.faintShaftsPath);
			ctx.restore();
		}

		// 4. Nodes: one cached Path2D per look — filled discs, stroked rings.
		for (const g of this.nodeGroups) {
			ctx.globalAlpha = g.alpha;
			if (g.lineWidth > 0) {
				ctx.strokeStyle = g.color;
				ctx.lineWidth = g.lineWidth;
				ctx.stroke(g.path);
			} else {
				ctx.fillStyle = g.color;
				ctx.fill(g.path);
			}
		}
		ctx.globalAlpha = 1;

		// 5. Dependency layer: blocked rings, route halos, then (zoomed into
		//    a Factory only) the arrows. All colours from dep-palette.
		this.drawDependencyLayer(ctx, ratio, k, w, h);

		// 6. Node labels — one global gate (per-node gate multiplier: big
		// nodes label later), faded together. World-scaled with the graph
		// (they grow as you zoom in, Obsidian-style).
		if (nodeAlpha > 0.01) {
			ctx.save();
			ctx.font = this.worldLabelFont;
			for (const [id, lines] of this.labelLines) {
				const n = this.nodeById.get(id);
				if (!n) continue;
				const routeDone = !!this.route?.nodes.has(id) && this.route.done.has(id);
				const a = labelAlpha(ratio, settings.labelZoom * (n.labelGate ?? 1)) * (routeDone ? DEP_STYLE.routeDoneNodeAlpha : (n.dim ? DIM_LABEL_ALPHA : 1) * this.restDim(id));
				if (a <= 0.01) continue;
				ctx.globalAlpha = a;
				drawNameLines(ctx, n.x, n.y, lines, this.world, this.radiusOf(n), routeDone ? ROUTE_DONE_COLOR : data.colors.label);
			}
			ctx.restore();
		}

		// 7. Hover glow (topmost over content): halo in the node's colour +
		// the brightened name, both on the SAME fade factor. World units
		// like everything else. Shows even when labels are zoomed out
		// (hover is its own affordance, not a label).
		if (this.hoverNode && this.hoverFade > 0.02) {
			const n = this.visible && !this.visible.has(this.hoverNode.id)
				? null // filtered out by search — no glow on hidden nodes
				: this.hoverNode;
			if (n) {
				const nodeR = this.radiusOf(n);
				const glowOuter = nodeR * GLOW_SCALE;
				const color = n.color ?? data.colors.node;
				const glow = ctx.createRadialGradient(n.x, n.y, nodeR, n.x, n.y, glowOuter);
				glow.addColorStop(0, rgbaFromHex(color, GLOW_ALPHA * this.hoverFade));
				glow.addColorStop(1, rgbaFromHex(color, 0));
				ctx.fillStyle = glow;
				ctx.beginPath();
				ctx.arc(n.x, n.y, glowOuter, 0, Math.PI * 2);
				ctx.arc(n.x, n.y, nodeR, 0, Math.PI * 2, true);
				ctx.fill("evenodd");
				ctx.save();
				ctx.globalAlpha = this.hoverFade;
				ctx.font = this.worldLabelFont;
				drawNameLines(ctx, n.x, n.y, this.labelLines.get(n.id) ?? [], this.world, nodeR, data.colors.hoverText);
				ctx.restore();
			}
		}

		// 7b. Activity pulses: the same halo, in the node's colour, fading
		// with age (static while reduced motion is on). Expired ones drop.
		if (this.pulses.size > 0) {
			const now = performance.now();
			for (const [id, p] of this.pulses) {
				const reduce = p.reduce;
				const age = (now - p.start) / p.ms;
				if (age >= 1) {
					this.pulses.delete(id);
					continue;
				}
				const n = this.nodeById.get(id);
				if (!n || (this.visible && !this.visible.has(id))) continue;
				const strength = reduce ? 1 : 1 - age;
				const nodeR = this.radiusOf(n);
				const outer = nodeR * (reduce ? GLOW_SCALE : GLOW_SCALE + 0.6 * age);
				const color = n.color ?? data.colors.node;
				const glow = ctx.createRadialGradient(n.x, n.y, nodeR, n.x, n.y, outer);
				glow.addColorStop(0, rgbaFromHex(color, Math.min(1, GLOW_ALPHA * 2 * strength)));
				glow.addColorStop(1, rgbaFromHex(color, 0));
				ctx.fillStyle = glow;
				ctx.beginPath();
				ctx.arc(n.x, n.y, outer, 0, Math.PI * 2);
				ctx.arc(n.x, n.y, nodeR, 0, Math.PI * 2, true);
				ctx.fill("evenodd");
			}
		}

		// 8. Cluster region labels — THE TOPMOST layer (user 2026-09-16:
		// node labels and hover names drew over them before; region labels
		// must never be occluded by content). Inverse-gated on THE zoom
		// control (visible zoomed-out, fading as node labels come in).
		// Viewer-relative by design (UI, not graph content): drawn at the
		// world centroid with a font of clusterLabelSize / k — a constant
		// size on screen at any zoom (user-tunable since 2026-09-16).
		// Wave 7: labels are session names / file paths — pre-wrapped at
		// the geometry build (cap + ellipsis), drawn centered on the
		// centroid line by line.
		if (settings.clusterLabels && regionAlpha > 0.01) {
			ctx.save();
			ctx.globalAlpha = regionAlpha;
			ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize / k}px ${data.fontFamily}`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			// Screen px ÷ k = world units — the lines stay evenly spaced
			// at a constant on-screen pitch at any zoom.
			const lineH = (settings.clusterLabelSize * REGION_LABEL_LINE_HEIGHT) / k;
			for (const rm of this.regionMeta) {
				if (!rm.lines) continue;
				ctx.fillStyle = rgbaFromHex(rm.color, 0.9);
				const firstOffset = (-(rm.lines.length - 1) / 2) * lineH;
				for (let i = 0; i < rm.lines.length; i++) {
					ctx.fillText(rm.lines[i]!, rm.cx, rm.cy + firstOffset + i * lineH);
				}
			}
			ctx.restore();
		}
	}
}
