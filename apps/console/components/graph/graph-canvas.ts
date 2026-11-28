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
 * Unit tests cover the pure helpers (tests/components/graph/graph-canvas.test.ts); the
 * class itself is DOM-bound and exercised live. Module scope stays
 * DOM-free so the file imports cleanly under Node.
 */

import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { buildDepDrawList, type DepArrow, type DepRouteSelection } from "@/src/core";
import { DEP_COLORS, DEP_STYLE, DEP_SPRING_STRENGTH, ROUTE_DONE_COLOR } from "@/src/core";
import { redactLines } from "@/src/core";
import { isMotionReduced, type MotionMode } from "@/src/core";
import { recentreCamera, recentreOffset } from "@/src/core";
import type { Simulation, SimulationLinkDatum } from "d3-force";
import type { Pt } from "./cluster-geometry.ts";
import { LabelPass, type GroupTitle } from "./label-pass.ts";
import { computeGroupShapes, drawGroupShapes, groupAt, type GroupShape } from "./group-regions.ts";
import { DEFAULT_RENDER_SETTINGS, effectiveZoom, labelsOn, type LabelObstacle } from "@/src/core";
const NO_OBSTACLES = { n: 0, sig: 0 };
import type { LiveOverlay, OverlayHighlight, OverlayHit, OverlayHost } from "./live/live-overlay";
import {
	CHARGE_STRENGTH,
	CLUSTER_PULL_STRENGTH,
	GROUP_PULL_STRENGTH,
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
 *  the draw style (src/core/graph/kb-graph-model.ts nodeStyle / domain colour). */
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

/** One visual group: all its member node ids (layout pull) and the members per domain (the bubble). */
export interface CanvasGroup {
	id: string;
	label: string;
	color: string;
	members: string[];
	parts: string[][];
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
	/** Visual groups of domains: a big soft bubble behind the domain regions, a title, a gentle layout pull. */
	groups?: CanvasGroup[];
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
	/** Live overlay: the pointer is over a wolf / thread / subagent (null = left it). */
	onOverlayHover?: (hit: OverlayHit | null) => void;
	/** Live overlay: a click or tap (not a drag) landed on one. */
	onOverlaySelect?: (hit: OverlayHit, pointerType: string) => void;
}

// ─── Constants (ported verbatim from the sigma view) ────────────────────────

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
const EMPTY_TITLES: GroupTitle[] = [];
const LABEL_MIN_SCREEN_PX = 6; // labels smaller than this on screen are skipped
const LABEL_CULL_MARGIN = 150; // screen px around the viewport that still draws labels
const SIM_FIELDS = new Set(["x", "y", "vx", "vy", "fx", "fy", "index"]); // mutated by the sim; not content
const TOUCH_MAX_DPR = 2; // coarse-pointer (touch) devices render at most 2x

/** devicePixelRatio, capped at 2 on touch devices (a 3x phone canvas costs 2.25x the fill for no visible gain). */
function effectiveDpr(): number {
	const raw = window.devicePixelRatio || 1;
	return raw > TOUCH_MAX_DPR && window.matchMedia?.("(pointer: coarse)").matches ? TOUCH_MAX_DPR : raw;
}



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

/**
 * Section (cluster region tint + cluster label) opacity at a camera ratio.
 * Sections fade IN as you zoom into them: 1 at/below labelZoom (zoomed in),
 * 0 at labelZoom + span and beyond (zoomed out). Same threshold and smooth
 * span as labelAlpha; before, sections used 1 - labelAlpha (the reverse).
 */
export function sectionAlpha(
	ratio: number,
	labelZoom: number,
	span = labelZoom * LABELS_FADE_RATIO,
): number {
	return labelAlpha(ratio, labelZoom, span);
}

/**
 * Does a camera (screen = world * k + translate) show the world bbox in a
 * w×h viewport? A stored camera that doesn't (the layout moved, or it was
 * saved against a drifted one) leaves a blank graph, so the caller re-fits
 * instead of trusting it. A sliver at the edge doesn't count: the viewport
 * centre must lie in the padded bbox, or the overlap must cover about 10% of
 * the viewport, or the whole bbox must be on screen (a lone node).
 */
export function cameraFramesWorld(
	camera: { x: number; y: number; k: number },
	bbox: { minX: number; maxX: number; minY: number; maxY: number },
	w: number,
	h: number,
): boolean {
	const { x, y, k } = camera;
	if (!Number.isFinite(k) || !(k > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
	if (!(w > 0) || !(h > 0)) return false;
	const left = -x / k;
	const right = (w - x) / k;
	const top = -y / k;
	const bottom = (h - y) / k;
	const pad = Math.max(0.1 * Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY), 24 / k);
	const cx = (left + right) / 2;
	const cy = (top + bottom) / 2;
	if (cx >= bbox.minX - pad && cx <= bbox.maxX + pad && cy >= bbox.minY - pad && cy <= bbox.maxY + pad) return true;
	const ow = Math.min(right, bbox.maxX) - Math.max(left, bbox.minX);
	const oh = Math.min(bottom, bbox.maxY) - Math.max(top, bbox.minY);
	if (ow < 0 || oh < 0) return false;
	if (ow * oh >= 0.1 * (right - left) * (bottom - top)) return true;
	return bbox.minX >= left && bbox.maxX <= right && bbox.minY >= top && bbox.maxY <= bottom;
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
	privateView = false,
	k = 1,
	batched = false,
): void {
	context.fillStyle = color;
	context.textAlign = "center";
	context.textBaseline = "top";
	const firstTop = y + radius + world.labelGap;
	// Private view: the same footprint as soft blurred dots, no readable text.
	// Batched (the node-label pass): the caller set the blur once for the whole batch, only the glow colour follows the label.
	if (privateView) {
		if (batched) context.shadowColor = color;
		else blurLabels(context, color, world.labelSize * 0.45, k);
	}
	const shown = redactLines(lines, privateView);
	for (let i = 0; i < shown.length; i++) {
		context.fillText(shown[i]!, x, firstTop + i * world.labelSize * LABEL_LINE_HEIGHT);
	}
	if (privateView && !batched) context.shadowBlur = 0;
}

/** Private view: a soft glow under the redacted label (shadowBlur works in every canvas, unlike ctx.filter on Safari). `blurWorld` is in
 *  world units; shadowBlur ignores the transform, so it is scaled by the current zoom. Callers reset it. */
function blurLabels(context: CanvasRenderingContext2D, color: string, blurWorld: number, k: number): void {
	context.shadowColor = color;
	context.shadowBlur = blurWorld * k * (devicePixelRatioOf());
}

/** The canvas' device-pixel factor on the base transform (the camera transform's scale is dpr * k). */
let blurDpr = 1;
const devicePixelRatioOf = (): number => blurDpr;

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

/** The shared motion-mode input: 'Always animate' ignores the OS Reduce motion switch. */
function prefersReducedMotion(mode: MotionMode = "follow"): boolean {
	return isMotionReduced(mode);
}

export class GraphCanvasRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private callbacks: RendererCallbacks;
	private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>;
	private transform: ZoomTransform = zoomIdentity;
	/** Set once the first fit happens; the camera then survives setData. */
	private hasFit = false;
	/** The restored camera while the user hasn't touched it: re-checked
	 *  against the world bbox on every setData (staged loads), dropped once the
	 *  user moves the camera or a fit replaces it. */
	private restoredCamera: { x: number; y: number; k: number } | null = null;
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
	/** Only the overlay changed (requestRedraw): the cached base layers can be reused. `dirty` (markDirty) means the base is stale. */
	private overlayDirty = false;
	/** The previous tick ran a base animation (hover fade, zoom glide, sim, pulses): the next draw is a full one so the settle frame lands. */
	private lastBaseAnim = false;
	/** The last tick animated only the overlay: the next ticks may wait out its frame floor. */
	private overlayOnlyAnim = false;
	/** Layers 1-7b rendered once per base change (offscreen, device pixels); overlay frames blit it instead of redrawing ~2k nodes. */
	private baseLayer: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
	private baseKey = "";
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
	/** Semantic-zoom labels (levels, collisions, fades): see label-pass.ts. */
	private labels = new LabelPass();
	private selectedId: string | null = null;
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
	/** Embedded graphs (a panel, not the page) keep the whole graph fitted to their container on every resize until the user pans or zooms. */
	private autoFit = false;
	private onUserCamera = (): void => {
		this.autoFit = false;
	};
	setAutoFit(on: boolean): void {
		this.autoFit = on;
		if (on) this.fit();
	}
	private downPos: Pt | null = null;
	/** The live overlay (wolves, satellites, pulses): drawn above the nodes inside THIS loop; null = nothing changes. */
	private destroyed = false;
	private overlay: LiveOverlay | null = null;
	private overlayHoverKey: string | null = null;
	/** The effective label zoom of the last frame, and the wolf badges as label obstacles (reused every frame). */
	private lastLabelZe = 0;
	private readonly badgeObstacles: LabelObstacle[] = [];
	private overlayDown: OverlayHit | null = null;
	private lastDrawAt = 0;

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
	/** Value key of the tuning the sim was built with. */
	private physicsKey = JSON.stringify(DEFAULT_PHYSICS_TUNING);
	private regionBuiltVersion = -1;
	private hasBlocked = false;
	/** Content signature (no positions or sim state) of the data last applied. */
	private dataKey = "";
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
		canvas.addEventListener("wheel", this.onUserCamera, { passive: true });
		canvas.addEventListener("pointerdown", this.onUserCamera);
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
			this.restoredCamera = { x: initialCamera.x, y: initialCamera.y, k: initialCamera.k }; // validated against the world once data and size are known
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
			this.validateRestoredCamera();
			if (!this.hasFit || this.autoFit) this.fit(); // first real size → fit once; an embedded graph refits to its panel until the user moves the camera
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
			this.guardOverlay((o) => o.onResize(), undefined);
			this.draw(true);
		});
		this.resizeObserver.observe(canvas);
		this.syncSize();
	}

	// ── Public API ──

	setData(data: CanvasData): void {
		// A refetch that changed nothing (same ids, styles, links, and every node where the renderer has it) must not rebuild the sim.
		const dataKey = JSON.stringify(data, (key, v) => (SIM_FIELDS.has(key) ? undefined : v));
		if (this.data && dataKey === this.dataKey && data.nodes.every((n) => {
			const cur = this.nodeById.get(n.id);
			return !!cur && cur.x === n.x && cur.y === n.y;
		})) {
			return;
		}
		this.dataKey = dataKey;
		// A rest state waiting out its debounce belongs to the OLD nodes:
		// commit it before they are replaced.
		this.flushCommit();
		if (!this.data) this.recentreOnFirstLoad(data);
		this.data = data;
		this.nodeById = new Map(data.nodes.map((n) => [n.id, n]));
		this.hasBlocked = data.nodes.some((n) => n.blocked);
		this.labels.setHierarchy(this.nodeById.keys(), data.edges, data.depths ?? new Map());
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
		this.validateRestoredCamera();
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
		const reduce = prefersReducedMotion(this.settings?.live?.motion);
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
		const next = sanitizePhysicsTuning(input);
		// Compare by value: the settings object is swapped (defaults, then the
		// loaded copy) with equal contents on every mount; only a real change
		// rebuilds and re-anneals the layout.
		const key = JSON.stringify(next);
		if (key === this.physicsKey) return;
		this.physicsKey = key;
		this.physicsTuning = next;
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

	/** The first data of a renderer: a layout sitting off the origin is
	 *  translated to it (recentre.ts), the camera shifted by the same world
	 *  offset so the screen is unchanged, and the new positions committed once.
	 *  The origin gravity and depth anchor then have nothing to pull, so the
	 *  first drag or reheat does not slide the whole graph. Later data is left
	 *  alone: the camera is world-relative and was already settled. */
	private recentreOnFirstLoad(data: CanvasData): void {
		const off = recentreOffset(data.nodes);
		if (!off) return;
		for (const n of data.nodes) {
			n.x -= off.x;
			n.y -= off.y;
		}
		if (this.hasFit) {
			const cam = recentreCamera(this.transform, off);
			select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity.translate(cam.x, cam.y).scale(cam.k));
			if (this.restoredCamera) {
				const t = this.transform;
				this.restoredCamera = { x: t.x, y: t.y, k: t.k };
			}
		}
		const positions: Record<string, Position> = {};
		for (const n of data.nodes) positions[n.id] = { x: n.x, y: n.y };
		this.callbacks.onCommit(positions);
	}

	/** A restored camera the user hasn't touched must frame the world; if it
	 *  doesn't, drop it so the graph is fitted instead. Checked on EVERY bbox
	 *  change while the camera is untouched (cameraFramesWorld is the gate), so
	 *  a staged load is judged on the data that finally arrives. The restored
	 *  camera stays armed until a laid-out check happens (the w/h < 10 guard
	 *  below returns before the check), then until the user moves it. */
	private validateRestoredCamera(): void {
		const rc = this.restoredCamera;
		if (!rc || !this.worldBBox || !this.data || this.data.nodes.length === 0) return;
		const t = this.transform;
		if (t.x !== rc.x || t.y !== rc.y || t.k !== rc.k) {
			this.restoredCamera = null; // the user moved it: theirs now
			return;
		}
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return; // not laid out yet; the next setData/resize checks
		// Owner decision (work-wolfpack-2wEvr00): fit on every page visit's first
		// laid-out load, not only when the stored camera is off the graph. The
		// saved camera is replaced; later pans persist as before.
		this.restoredCamera = null;
		this.hasFit = false;
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
	focusOn(ids: readonly string[], maxK = 4, animate = false): boolean {
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
		const dest = { k, x: w / 2 - cx * k, y: h / 2 - cy * k };
		if (animate) {
			this.flight = dest; // a ~200 ms glide (advanceZoom); reduced motion passes animate=false and jumps
			this.markDirty();
		} else {
			this.flight = null;
			select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity.translate(dest.x, dest.y).scale(k));
		}
		return true;
	}
	private flight: { k: number; x: number; y: number } | null = null;

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
		this.destroyed = true;
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		this.overlay = null;
		this.baseLayer = null;
		this.flushCommit();
		this.sim = null;
		this.simActive = false;
		this.dragId = null;
		this.resizeObserver.disconnect();
		select(this.canvas).on(".zoom", null);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointerdown", this.onUserCamera);
		this.canvas.removeEventListener("wheel", this.onUserCamera);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("dblclick", this.onDoubleClick);
		this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
		this.canvas.removeEventListener("contextmenu", this.onContextMenu);
		this.canvas.style.cursor = "";
	}

	/** Set once the overlay threw: it is skipped for the rest of the session so the graph itself keeps rendering. */
	private overlayBroken = false;
	/** Run an overlay call; an exception disables the overlay (logged once) and yields `fallback`. */
	private guardOverlay<T>(fn: (o: LiveOverlay) => T, fallback: T): T {
		const o = this.overlay;
		if (!o || this.overlayBroken) return fallback;
		try {
			return fn(o);
		} catch (err) {
			this.overlayBroken = true;
			console.error("live overlay disabled after an error", err);
			return fallback;
		}
	}

	/** Attach (or detach with null) the live overlay. The caller owns its lifetime; the renderer only draws and hit-tests it. */
	setOverlay(o: LiveOverlay | null, cbs?: Pick<RendererCallbacks, "onOverlayHover" | "onOverlaySelect">): void {
		this.overlay = o;
		this.overlayBroken = false;
		this.callbacks = { ...this.callbacks, onOverlayHover: cbs?.onOverlayHover, onOverlaySelect: cbs?.onOverlaySelect };
		if (!o) {
			this.setOverlayHover(null);
			this.setReplacedNodes(new Set());
		}
		this.markDirty();
	}

	/** Node ids whose dot the overlay replaces with its own (a feature hub on its work node): the base skips their discs, keeps edges and labels. */
	private replacedNodes: ReadonlySet<string> = new Set();
	/** Only a CHANGED set rebuilds the geometry and so the cached base; the same set again is a no-op. */
	setReplacedNodes(ids: ReadonlySet<string>): void {
		const cur = this.replacedNodes;
		if (ids.size === cur.size) {
			let same = true;
			for (const id of ids) if (!cur.has(id)) { same = false; break; }
			if (same) return;
		}
		this.replacedNodes = new Set(ids);
		this.geoVersion++;
		this.markDirty();
	}

	/** Ring a node / target / wolf on the overlay (the activity feed's hover); null clears it. */
	/** Which of these node ids are on the map (the activity replay picks its fly-to target from them). */
	nodesOnMap(ids: readonly string[]): Set<string> {
		return new Set(ids.filter((id) => this.nodeById.has(id)));
	}

	/** The map's tree edges and node ids, for the kbdemo to pick real filing targets from. */
	demoGraph(): { edges: readonly { from: string; to: string }[]; ids: string[] } {
		return { edges: this.data?.edges ?? [], ids: [...this.nodeById.keys()] };
	}

	setOverlayHighlight(h: OverlayHighlight | null): void {
		this.overlay?.setHighlight(h);
	}

	/** Request a redraw (the overlay calls this when its state changes). */
	requestRedraw(): void {
		if (this.destroyed) return;
		this.overlayDirty = true;
		this.schedule();
	}

	/** Bounding radius of all nodes about the graph's centre, for the wolves' free roam. Cached per base graph (nodeById identity). */
	private extentFor: Map<string, CanvasNode> | null = null;
	private extent = 0;
	private extentRadiusOf(): number | null {
		if (this.extentFor !== this.nodeById) {
			const b = this.worldBBox;
			const cx = b ? (b.minX + b.maxX) / 2 : 0;
			const cy = b ? (b.minY + b.maxY) / 2 : 0;
			let r = 0;
			for (const n of this.nodeById.values()) r = Math.max(r, Math.hypot(n.x - cx, n.y - cy));
			this.extent = r;
			this.extentFor = this.nodeById;
		}
		return this.extent > 0 ? this.extent : null;
	}

	private overlayHostCache: OverlayHost | null = null;
	private overlayHost(): OverlayHost {
		const data = this.data;
		if (this.overlayHostCache && this.overlayHostCache.colors === data?.colors) return this.overlayHostCache;
		const host: OverlayHost = {
			nodePos: (id) => {
				const n = this.nodeById.get(id);
				return n ? { x: n.x, y: n.y } : null;
			},
			hasNode: (id) => this.nodeById.has(id),
			nodeColor: (id) => this.nodeById.get(id)?.color,
			edgesOf: () => this.data?.edges ?? [],
			nodeRadius: (id) => {
				const n = this.nodeById.get(id);
				return n ? this.radiusOf(n) : null;
			},
			nodeLabel: (id) => this.nodeById.get(id)?.label,
			setReplacedNodes: (ids) => this.setReplacedNodes(ids),
			extentRadius: () => this.extentRadiusOf(),
			labelZoom: () => this.lastLabelZe,
			center: () => {
				const b = this.worldBBox;
				return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
			},
			colors: data?.colors ?? { node: "#888888", edge: "#888888", label: "#888888", hoverText: "#ffffff" },
			fontFamily: data?.fontFamily ?? "sans-serif",
		};
		this.overlayHostCache = host;
		return host;
	}

	/** The overlay thing under the pointer; touch gets a bigger pick pad. */
	private overlayHit(pos: Pt, pointerType: string): OverlayHit | null {
		return this.guardOverlay((o) => o.hitTest(pos.x, pos.y, this.transform, pointerType === "touch" ? 18 : 8), null);
	}

	private setOverlayHover(hit: OverlayHit | null): void {
		const key = hit ? hit.item.kind + ":" + hit.item.key : null;
		if (key === this.overlayHoverKey) return;
		this.overlayHoverKey = key;
		this.overlay?.setHover(key);
		this.callbacks.onOverlayHover?.(hit);
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
		if (e.pointerType !== "touch") {
			const oh = this.overlayHit(pos, e.pointerType);
			this.setOverlayHover(oh);
			if (oh) {
				if (this.hoverId) this.setHover(null);
				this.canvas.style.cursor = "pointer";
				return;
			}
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
		// An overlay thing under the press: remember it for the click, but do NOT take the press (pan and pinch stay d3-zoom's).
		// A hub that replaces a graph node is that node: the press goes to the node, as before the hub existed.
		const oh = this.overlayHit(pos, e.pointerType);
		this.overlayDown = oh?.item.nodeId ? null : oh;
		const node = this.overlayDown ? null : this.pickAt(pos.x, pos.y);
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
		this.flight = null;
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
		const od = this.overlayDown;
		this.overlayDown = null;
		if (moved > CLICK_SLOP) return; // that was a drag (pan), not a click
		if (od) {
			this.callbacks.onOverlaySelect?.(od, e.pointerType);
			return;
		}
		const node = this.pickAt(pos.x, pos.y);
		if (node) this.callbacks.onSelect(node.id, pos);
		else {
			this.callbacks.onStageClick();
			// On a touch screen a tap on a group's bubble zooms to it (a mouse keeps a plain stage click).
			if (e.pointerType === "touch" || e.pointerType === "pen") {
				const { x: tx, y: ty, k } = this.transform;
				const hit = groupAt(this.shapesNow(), (pos.x - tx) / k, (pos.y - ty) / k);
				if (hit) this.zoomToGroup(hit.id);
			}
		}
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
		this.setOverlayHover(null);
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
		// World-space scan, no per-move allocation: screen distance = world distance × k.
		const wx = (px - tx) / k;
		const wy = (py - ty) / k;
		let best: CanvasNode | null = null;
		let bestD = PICKING_PAD;
		for (const n of this.data.nodes) {
			if (this.visible && !this.visible.has(n.id)) continue;
			const d = Math.max((Math.hypot(n.x - wx, n.y - wy) - this.radiusOf(n)) * k, 0);
			if (d < bestD) {
				bestD = d;
				best = n;
			}
		}
		return best;
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

	/** The selected node: its label and its parent chain stay shown (the card owner calls this). */
	setSelectedNode(id: string | null): void {
		if (id === this.selectedId) return;
		this.selectedId = id;
		this.markDirty();
	}

	private groupShapes: GroupShape[] = [];
	private groupShapesKey = "";
	private groupShapesFor: CanvasGroup[] | undefined;

	/** Group bubbles at the current positions (recomputed when the geometry or the search filter changes). */
	private shapesNow(): GroupShape[] {
		const groups = this.data?.groups;
		if (!groups || groups.length === 0) return (this.groupShapes = []);
		const key = `${this.geoVersion}|${this.visible ? this.visible.size : -1}`;
		if (this.groupShapesFor !== groups) {
			this.groupShapesFor = groups;
			this.groupShapesKey = "";
		}
		if (key !== this.groupShapesKey) {
			this.groupShapesKey = key;
			this.groupShapes = computeGroupShapes(groups, (id) => this.nodeById.get(id), this.visible);
		}
		return this.groupShapes;
	}

	/** The group titles for the label pass: rebuilt only when the group shapes were (same array = same identity, so the pass skips its work). */
	private groupTitles(): GroupTitle[] {
		const shapes = this.shapesNow();
		if (shapes.length === 0) return EMPTY_TITLES;
		if (this.titlesFor !== shapes) {
			this.titlesFor = shapes;
			this.titles = shapes.map((s) => ({ id: s.id, label: s.label, color: s.color, x: s.cx, y: s.cy, size: s.size }));
		}
		return this.titles;
	}
	private titlesFor: GroupShape[] | null = null;
	private titles: GroupTitle[] = [];

	/** Zoom the camera to a group's bubble (the phone tap). True when the group exists. */
	zoomToGroup(id: string): boolean {
		const s = this.shapesNow().find((g) => g.id === id);
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (!s || w < 10 || h < 10) return false;
		const t = fitTransform(s.box, w, h, 40);
		select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity.translate(t.x, t.y).scale(t.k));
		return true;
	}

	private markDirty(): void {
		if (this.destroyed) return; // a late setOverlay(null) or overlay redraw after destroy must not start a frame loop
		this.dirty = true;
		this.schedule();
	}

	private schedule(): void {
		if (this.frameId === null && !this.inTick) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	private tick(): void {
		// Only the overlay is animating and nothing else asked for a frame: wait out its frame floor without stepping or drawing
		// (a 120 Hz screen must not run the overlay at 120 fps). lastTickAt stays put, so the next step's dt covers the wait.
		if (this.overlayOnlyAnim && !this.dirty && !this.overlayDirty && !this.lastBaseAnim) {
			const floor = this.guardOverlay((o) => o.minFrameMs, 0);
			if (floor > 0 && performance.now() - this.lastDrawAt < floor) {
				this.frameId = requestAnimationFrame(() => {
					this.frameId = null;
					this.tick();
				});
				return;
			}
		}
		this.inTick = true;
		try {
			const now = performance.now();
			// Clamp the dt: a long idle gap must not teleport the ease forward.
			const dt = Math.min(Math.max(now - this.lastTickAt, 8), 100);
			const wasDirty = this.dirty;
			this.lastTickAt = now;
			const hoverAnim = this.advanceHover();
			const zoomAnim = this.advanceZoom(dt);
			const simAnim = this.advanceSim();
			// Live overlay: its own small physics (reads node positions, never moves them) and its own animation need.
			if (this.geometryReady) this.guardOverlay((o) => o.step(now, dt / 1000, this.overlayHost(), this.transform.k), undefined);
			const overlayAnim = this.guardOverlay((o) => o.needsFrames(now), false);
			let pulseAnim = false;
			for (const p of this.pulses.values()) if (!p.reduce) pulseAnim = true;
			const baseAnim = hoverAnim || zoomAnim || simAnim || pulseAnim;
			const forceBase = baseAnim || this.lastBaseAnim;
			this.lastBaseAnim = baseAnim;
			// When ONLY the overlay animates, frames are overlay-only (cached base) and capped at the overlay's frame floor.
			const onlyOverlay = overlayAnim && !forceBase && !wasDirty;
			const minFrameMs = this.guardOverlay((o) => o.minFrameMs, 0);
			if (!(onlyOverlay && now - this.lastDrawAt < minFrameMs)) {
				this.draw(forceBase);
				this.lastDrawAt = now;
			}
			// Keep frames coming ONLY while an animation is in motion (hover
			// fade, zoom glide, or live physics); an idle graph schedules no
			// rAF at all.
			this.animating = baseAnim || overlayAnim || this.labels.needsFrames();
			this.overlayOnlyAnim = overlayAnim && !baseAnim;
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
		const f = this.flight;
		if (f) {
			const t0 = this.transform;
			const b = 1 - Math.exp(-dt / 60);
			const near = Math.abs(f.x - t0.x) < 0.5 && Math.abs(f.y - t0.y) < 0.5 && Math.abs(f.k - t0.k) / f.k < 0.002;
			const k = near ? f.k : t0.k + (f.k - t0.k) * b;
			const x = near ? f.x : t0.x + (f.x - t0.x) * b;
			const y = near ? f.y : t0.y + (f.y - t0.y) * b;
			if (near) this.flight = null;
			select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity.translate(x, y).scale(k));
			return !near;
		}
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
		const dpr = effectiveDpr();
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
		// Nothing to draw: no route, no blocked nodes, no dependency edges.
		if (!route && !this.hasBlocked && !(data.depEdges?.length)) return;
		ctx.save();
		// Blocked rings (always on) and the route's node halos.
		for (const n of route || this.hasBlocked ? data.nodes : []) {
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
		const positions = this.nodeById; // id → node, already indexed
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
			if (!isVisible(n.id) || this.replacedNodes.has(n.id)) continue;
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

		// Node labels are the label pass's (label-pass.ts), measured lazily there.
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
			// Origin, like the server layout and the depth anchor: a bbox-centred
			// pull would keep a drifted layout where it is. The sim only runs on
			// drag/reheat, never on load, so a settled layout is not moved or
			// re-committed by this.
			gravity: { x: 0, y: 0, strength: t.gravity },
			alphaDecay: LIVE_ALPHA_DECAY,
			velocityDecay: t.velocityDecay,
			chargeStrength: t.chargeStrength,
			linkStrength: t.linkStrength,
			linkDistance: t.linkDistance,
			linkLengths: data.linkLengths,
			depSprings: springs.length ? { edges: springs, strength: DEP_SPRING_STRENGTH } : undefined,
			clusterPull:
				data.clusters.length > 0 ? { clusters: data.clusters, strength: t.clusterPull } : undefined,
			groupPull: data.groups?.length ? { groups: data.groups, strength: GROUP_PULL_STRENGTH } : undefined,
			depthAnchor:
				t.depthMode === "off" || !data.depths
					? undefined
					: {
							mode: t.depthMode,
							depths: data.depths,
							strength: t.depthStrength,
							spacing: t.depthSpacing,
							baseRadius: t.depthBaseRadius,
							center: { x: 0, y: 0 },
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

	/** The offscreen base layer at the main canvas' pixel size, or null when it cannot be had (the base then draws straight to the canvas). */
	private ensureBaseLayer(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
		try {
			if (!this.baseLayer) {
				const canvas = document.createElement("canvas");
				const ctx = canvas.getContext("2d");
				if (!ctx) return null;
				this.baseLayer = { canvas, ctx };
			}
			const l = this.baseLayer;
			if (l.canvas.width !== w || l.canvas.height !== h) {
				l.canvas.width = w;
				l.canvas.height = h; // also clears
				this.baseKey = "";
			}
			return l;
		} catch {
			return null;
		}
	}

	/** THE draw function: every layer, one frame, one camera. All drawing
	 *  happens in WORLD coordinates under the camera transform; nothing is
	 *  recomputed per frame except layer styling. */
	private draw(forceBase = false): void {
		const baseStale = this.dirty || forceBase;
		this.dirty = false;
		this.overlayDirty = false;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = effectiveDpr();
		const ctx = this.ctx;
		blurDpr = dpr;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		// Regions: rebuild on stale geometry at rest; during the live sim,
		// every REGION_EVERY-th frame (others blit the last bitmap).
		if (this.regionBuiltVersion !== this.geoVersion && !this.simActive) {
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
		const regionAlpha = sectionAlpha(ratio, settings.labelZoom);

		// Layers 1-7b go to an offscreen cache and are reused while only the overlay changes. Besides the dirty flags, a key of everything
		// the base reads that can change without markDirty guards against a stale picture; a live sim or a hover fade never reuses it.
		const pxW = this.canvas.width;
		const pxH = this.canvas.height;
		const key = `${tx}|${ty}|${k}|${dpr}|${pxW}|${pxH}|${this.geoVersion}|${this.regionBuiltVersion}|${this.hoverNode?.id ?? ""}|${this.hoverFade}|${this.pulses.size}`;
		const layer = this.ensureBaseLayer(pxW, pxH);
		const reuse = !!layer && !baseStale && !this.simActive && key === this.baseKey;
		if (!reuse) {
			const mainCtx = ctx;
			{
			const ctx = layer ? layer.ctx : mainCtx;
			if (layer) {
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.clearRect(0, 0, pxW, pxH);
				ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
			}

		// 0. Group bubbles: large soft regions behind the domain regions (few shapes, cheap).
		if (this.data?.groups?.length) drawGroupShapes(ctx, this.shapesNow());

		// 1. Cluster regions: one tiny world-space bitmap blit. The upscale
		//    blur is the region softness; adjacent cluster tints blend
		//    source-over where they overlap (decided: multiply is invisible
		//    on the dark background).
		if (this.regionCanvas && this.regionRect && regionAlpha > 0.01) {
			const { minX, minY, w, h } = this.regionRect;
			ctx.imageSmoothingEnabled = true;
			ctx.globalAlpha = regionAlpha;
			ctx.drawImage(this.regionCanvas, minX, minY, w, h);
			ctx.globalAlpha = 1;
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

		// 6. (Node labels moved to the semantic-zoom pass at the end of draw: label-pass.ts.)

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

			}
			this.baseKey = layer ? key : "";
		}
		if (layer) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.drawImage(layer.canvas, 0, 0);
			ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
		}

		// 7c. Live overlay: wolves, satellites, trails, pulses, rings (same camera; nothing when it has no data).
		this.guardOverlay((o) => o.draw(ctx, this.overlayHost(), k, performance.now()), undefined);
		// 7d. The overlay's screen-space pass (the you badge): device scale only, no camera.
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.guardOverlay((o) => o.drawScreen?.(ctx, this.overlayHost(), this.transform, { w, h }, performance.now()), undefined);

		const labelZe = effectiveZoom(1 / ratio, settings.labelZoom);
		this.lastLabelZe = labelZe;
		const obs = this.guardOverlay((o) => o.fillObstacles(this.badgeObstacles, this.transform), NO_OBSTACLES);
		// 8. Labels, topmost: semantic zoom by hierarchy level, collisions resolved by level, hover/selection chain always shown.
		this.labels.draw({
			ctx,
			tx,
			ty,
			k,
			w,
			h,
			ze: labelZe,
			obstacles: this.badgeObstacles,
			obstacleCount: obs.n,
			obstacleSig: obs.sig,
			on: labelsOn(settings),
			clusterLabels: settings.clusterLabels,
			clusterScale: settings.clusterLabelSize / DEFAULT_RENDER_SETTINGS.clusterLabelSize,
			hoverId: this.hoverNode && this.hoverTarget > 0 ? this.hoverNode.id : null,
			selectedId: this.selectedId,
			reduce: prefersReducedMotion(settings.live?.motion),
			privateView: settings.privateView,
			textColor: data.colors.label,
			fontFamily: data.fontFamily,
			nodes: this.nodeById,
			radiusOf: (n) => this.radiusOf(n as CanvasNode),
			visible: this.visible,
			groups: this.groupTitles(),
			geoVersion: this.geoVersion,
			now: performance.now(),
		});
	}
}
