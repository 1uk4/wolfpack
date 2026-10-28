"use client";

/**
 * The knowledge-graph canvas view: the learnharness Knowledge map, repurposed
 * for the KB graph the librarian serves.
 *
 * The renderer (./graph-canvas.ts) is a dumb draw function over plain data
 * with ONE requestAnimationFrame loop and a dirty flag; this component's job
 * is everything AROUND drawing: turn the KbGraph payload into canvas data
 * (src/core/kb-graph-model.ts — domain colours, node styles, glow groups),
 * give every node a position (stored positions, then the shared d3-force
 * layout for the rest), resolve theme colours to hex, filter via the search
 * box, and own the docked detail pane / settings panel.
 *
 * Data comes IN: graph-home.tsx fetches the payload (and re-fetches on layer
 * toggles); a new payload for the same renderer keeps every position the
 * renderer already has and the camera where the user left it.
 *
 * Positions are keyed by node id and live in the console's own store
 * (/api/graph/positions); the camera is per-device (localStorage). The
 * settings (sizes, regions, physics, view toggles) are server-persisted by
 * the owner (use-graph-settings.ts). The KB is never written.
 *
 * Programmatic focus: `focusNode(id)` (also reachable as
 * `controllerRef.current.focusNode`) frames a node and opens its pane — the
 * `/?focus=<nodeId>` URL param goes through it.
 */

import type { DepRouteSelection } from "../src/core/dep-draw-list.ts";
import { featureTaskModel, reconcileCursor, rawWorkId, routeForNode, toRouteSelection } from "../src/core/dep-route-adapter.ts";
import { startCursor, type RouteCursor } from "../src/core/work-route.ts";
import { TaskGraphOverlay } from "./task-graph.tsx";
import type { RouteNavModel } from "./graph-route-nav.tsx";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon, WaypointsIcon } from "lucide-react";
import {
	GRAPH_CAMERA_KEY,
	describeNode,
	workRouteView,
	parseCamera,
	resolvePositions,
	sanitizePositions,
	toCanvasData,
	visibleNodeIds,
	type KbGraph,
	type GraphRenderSettings,
	type Position,
} from "@/src/core";
import { GraphCanvasRenderer } from "./graph-canvas.ts";
import { GraphPane } from "./graph-pane.tsx";
import { GraphSettingsControl } from "./graph-settings-panel.tsx";
import { WorkButton, useWorkView } from "./work-view-entry.tsx";
import { Hint } from "@/components/ui/hint";

/** The default node look when a node carries no colour of its own. */
const NODE_COLOR_TOKEN = "--primary";

type RenderSettings = GraphRenderSettings;

// ---- Color helpers (canvas wants hex, not oklch) ---------------------------

/** Resolve a CSS variable (oklch in this app) to #rrggbb via the canvas. */
function cssColorToHex(css: string): string {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return "#888888";
	ctx.fillStyle = css;
	ctx.fillRect(0, 0, 1, 1);
	const { data } = ctx.getImageData(0, 0, 1, 1);
	return `#${[data[0]!, data[1]!, data[2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function tokenHex(cssVar: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
	return value ? cssColorToHex(value) : "#888888";
}

// ---- The controller handed to the owner ------------------------------------

/** What graph-home (and later the Live-activity task) can reach through
 *  `controllerRef`. Valid while the canvas is mounted (null otherwise). */
export interface GraphViewController {
	/** The canvas renderer instance (pulse/animation APIs live there). */
	renderer: () => GraphCanvasRenderer | null;
	/** Frame a node and open its card. False when it isn't in the graph. */
	focusNode: (nodeId: string) => boolean;
}

interface Selection {
	id: string;
}

/** A feature's task-graph overlay, built from the payload (double-click on a feature). */
export function FeatureTaskOverlay({ graph, featureId, onClose, onSelectNode }: { graph: KbGraph; featureId: string; onClose: () => void; onSelectNode: (nodeId: string) => void }) {
	const model = useMemo(() => featureTaskModel(graph, featureId), [graph, featureId]);
	if (!model) return null;
	return <TaskGraphOverlay model={model} onClose={onClose} onSelect={(taskId) => onSelectNode(`work:${taskId}`)} />;
}

/** Whether double-clicking this node opens a task-graph overlay. */
export const opensTaskOverlay = (graph: KbGraph, nodeId: string): boolean => featureTaskModel(graph, nodeId) !== null;

// ---- Chrome ---------------------------------------------------------------

/** The top-chrome actions row's body: the search box (only when there are
 *  nodes to search — dead controls are lies) and the settings gear (always:
 *  the view toggles and the domain filter are how an empty view gets
 *  un-emptied). Exported pure for the SSR pins. */
export function GraphChromeRow({
	isEmpty,
	query,
	onQuery,
	noMatch,
	searchInputRef,
	settings,
	changeSettings,
	domains = [],
}: {
	isEmpty: boolean;
	query: string;
	onQuery: (v: string) => void;
	/** The search panel's "No matching nodes." note (computed by the
	 *  wrapper — it owns visibleIds + the graph). */
	noMatch: boolean;
	searchInputRef: React.RefObject<HTMLInputElement | null>;
	settings: GraphRenderSettings;
	changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
	domains?: KbGraph["domains"];
}) {
	return (
		<>
			{!isEmpty && (
				<div className="graph-chrome-fade-in w-56 min-w-0 shrink rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
					<Hint
						// ⌘F focuses node search (surface-scoped registry action).
						label="Search nodes"
						action="find"
						side="bottom"
					>
						<div className="relative">
							<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
							<input
								ref={searchInputRef}
								value={query}
								onChange={(e) => onQuery(e.target.value)}
								placeholder="Search nodes…"
								aria-label="Search nodes"
								spellCheck={false}
								className="h-7 w-full rounded-lg border bg-background pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
							/>
						</div>
					</Hint>
					{noMatch && <div className="px-1.5 pt-1 text-[11px] text-muted-foreground">No matching nodes.</div>}
				</div>
			)}
			<div className="graph-chrome-fade-in flex shrink-0 items-center gap-2">
				<WorkButton />
				<GraphSettingsControl settings={settings} changeSettings={changeSettings} domains={domains} />
			</div>
		</>
	);
}

// ---- Component ------------------------------------------------------------

export function GraphView({
	graph,
	settings,
	changeSettings,
	focusId = null,
	onFocusHandled,
	controllerRef,
	route = null,
}: {
	graph: KbGraph;
	settings: GraphRenderSettings;
	changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
	/** A node to frame + open once the canvas has it (the `/?focus=` param).
	 *  `onFocusHandled` fires once it has been acted on. */
	focusId?: string | null;
	onFocusHandled?: (nodeId: string) => void;
	controllerRef?: React.MutableRefObject<GraphViewController | null>;
	/** An externally supplied route; the selected node's own route wins. */
	route?: DepRouteSelection | null;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const rendererRef = useRef<GraphCanvasRenderer | null>(null);
	const [selected, setSelected] = useState<Selection | null>(null);
	const [overlayId, setOverlayId] = useState<string | null>(null);
	const graphRef = useRef(graph);
	graphRef.current = graph;
	const router = useRouter();

	// Search: the query text; ⌘F (shortcut wave C) focuses it — the find
	// event is surface-scoped, dispatched as lh:kbd-find (only this page
	// listens).
	const [query, setQuery] = useState("");
	const searchInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const onFind = () => searchInputRef.current?.focus();
		window.addEventListener("lh:kbd-find", onFind);
		return () => window.removeEventListener("lh:kbd-find", onFind);
	}, []);

	const canvasData = useMemo(() => toCanvasData(graph, { groupBy: settings.groupBy }), [graph, settings.groupBy]);
	const visibleIds = useMemo(() => visibleNodeIds(graph.nodes, query), [graph, query]);
	const isEmpty = graph.nodes.length === 0;

	// The stored positions (the console's own store), loaded once. The
	// first data feed waits for them so a restart reopens the layout as it
	// was left.
	const storedRef = useRef<Map<string, Position>>(new Map());
	const [storedLoaded, setStoredLoaded] = useState(false);
	useEffect(() => {
		let cancelled = false;
		fetch("/api/graph/positions")
			.then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
			.then((raw) => {
				if (cancelled || raw === null) return;
				storedRef.current = new Map(Object.entries(sanitizePositions(raw)));
			})
			.catch(() => {
				// unreachable → lay out fresh, nothing remembered
			})
			.finally(() => {
				if (!cancelled) setStoredLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const commitPositions = (positions: Record<string, Position>) => {
		void fetch("/api/graph/positions", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(positions),
		}).catch((err) => console.error("[graph] positions commit failed", err));
	};

	// Construct the renderer once the canvas exists; destroy when it goes
	// away (the empty placeholder replaces it). The callbacks are created
	// once and read through refs, so they never go stale.
	useEffect(() => {
		if (isEmpty) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		// Persisted camera: the graph reopens exactly where the user left it
		// (zoom AND pan, per-device in localStorage). Absent or corrupt →
		// null → the renderer fits on first open.
		let initialCamera: { k: number; x: number; y: number } | null = null;
		try {
			initialCamera = parseCamera(localStorage.getItem(GRAPH_CAMERA_KEY));
		} catch {
			// storage blocked → treat as absent
		}
		// Debounced camera writes: a pan emits hundreds of transforms per
		// second; one trailing write per quiet spell is plenty.
		let cameraTimer: ReturnType<typeof setTimeout> | null = null;
		let lastCamera: { k: number; x: number; y: number } | null = null;
		const writeCamera = (t: { k: number; x: number; y: number }) => {
			try {
				localStorage.setItem(GRAPH_CAMERA_KEY, JSON.stringify(t));
			} catch {
				// Storage full/blocked: camera persistence is best-effort.
			}
		};
		const persistCamera = (t: { k: number; x: number; y: number }) => {
			lastCamera = t;
			if (cameraTimer) clearTimeout(cameraTimer);
			cameraTimer = setTimeout(() => {
				cameraTimer = null;
				writeCamera(t);
			}, 250);
		};
		const renderer = new GraphCanvasRenderer(
			canvas,
			{
				onSelect: (nodeId) => {
					// A collapsed feature on the selected route expands in place
					// instead of re-targeting the route.
					const raw = rawWorkId(nodeId);
					if (raw && collapsedRef.current.has(raw)) setExpanded((prev) => ({ id: selectedIdRef.current, set: new Set([...(prev.id === selectedIdRef.current ? prev.set : []), raw]) }));
					else setSelected({ id: nodeId });
				},
				onStageClick: () => setSelected(null),
				onNodeDoubleClick: (nodeId) => {
					if (opensTaskOverlay(graphRef.current, nodeId)) setOverlayId(nodeId);
				},
				// (Debounced) remember where the camera stands.
				onCameraMove: persistCamera,
				// Live physics settled: remember the new rest state. The store
				// merges the batch, so ids hidden by a layer toggle are kept.
				onCommit: (positions) => {
					for (const [id, p] of Object.entries(positions)) storedRef.current.set(id, p);
					commitPositions(positions);
				},
			},
			initialCamera,
		);
		rendererRef.current = renderer;
		return () => {
			rendererRef.current = null;
			// Flush a pending camera write so an unmount <250ms after a move
			// still persists the user's last standpoint.
			if (cameraTimer && lastCamera) {
				clearTimeout(cameraTimer);
				cameraTimer = null;
				writeCamera(lastCamera);
			}
			renderer.destroy();
		};
	}, [isEmpty]);

	// Feed #1 — data: nodes (with positions + styles), edges, glow groups,
	// resolved colours. A new payload keeps every position the renderer
	// already has (including unsaved drags), then the stored ones; only
	// brand-new nodes are laid out (and remembered).
	useEffect(() => {
		const renderer = rendererRef.current;
		if (!renderer || isEmpty || !storedLoaded) return;
		const known = renderer.positions();
		for (const [id, p] of storedRef.current) if (!known.has(id)) known.set(id, p);
		const { positions, added } = resolvePositions(canvasData.nodes, canvasData.edges, known, { clusters: canvasData.clusters, depSprings: { edges: canvasData.depSprings }, linkLengths: canvasData.linkLengths });
		if (added.length > 0) {
			const batch: Record<string, Position> = {};
			for (const id of added) {
				const p = positions.get(id)!;
				storedRef.current.set(id, p);
				batch[id] = p;
			}
			commitPositions(batch);
		}
		renderer.setData({
			nodes: canvasData.nodes.map((n) => ({ ...n, x: positions.get(n.id)!.x, y: positions.get(n.id)!.y })),
			edges: canvasData.edges,
			depEdges: canvasData.depEdges,
			depSprings: canvasData.depSprings,
			linkLengths: canvasData.linkLengths,
			clusters: canvasData.clusters,
			subClusters: canvasData.subClusters,
			depths: canvasData.depths,
			colors: {
				node: tokenHex(NODE_COLOR_TOKEN),
				edge: tokenHex("--ring"),
				label: tokenHex("--muted-foreground"),
				hoverText: tokenHex("--foreground"),
			},
			// Match the app typography (Geist via the body's stack).
			fontFamily: getComputedStyle(document.body).fontFamily,
		});
	}, [canvasData, isEmpty, storedLoaded]);

	// The selected work item's route (the Factory, entries etc. have none) and
	// the card's cursor on it. The cursor restarts at the first unfinished
	// step whenever the route is recomputed; clearing the selection clears both.
	const selectedId = selected?.id ?? null;
	// Features the user expanded on this selection (reset on a new selection).
	const [expanded, setExpanded] = useState<{ id: string | null; set: ReadonlySet<string> }>({ id: null, set: new Set() });
	const expandedSet = expanded.id === selectedId ? expanded.set : undefined;
	const selectedRoute = useMemo(() => (selectedId ? routeForNode(graph, selectedId, { expanded: expandedSet }) : null), [graph, selectedId, expandedSet]);
	const collapsedRef = useRef<ReadonlySet<string>>(new Set());
	collapsedRef.current = new Set(Object.keys(selectedRoute?.collapsed ?? {}));
	const selectedIdRef = useRef<string | null>(null);
	selectedIdRef.current = selectedId;
	// Keyed by the selected id: a refetch recomputes the route but the cursor
	// stays on its node (reconcileCursor); a new selection starts fresh.
	const [cursorState, setCursorState] = useState<{ id: string; cursor: RouteCursor } | null>(null);
	const cursor: RouteCursor | null = selectedRoute
		? reconcileCursor(selectedRoute, cursorState?.id === selectedId ? cursorState.cursor : null)
		: null;
	const cursorRef = useRef<RouteCursor | null>(null);
	cursorRef.current = cursor;
	useEffect(() => {
		// Pin the effective cursor so later payloads reconcile against it.
		if (selectedId && cursor && (cursorState?.id !== selectedId || cursorState.cursor.node !== cursor.node)) setCursorState({ id: selectedId, cursor });
	}, [selectedId, cursor, cursorState]);
	const routeSelection = useMemo(() => {
		if (!selectedRoute) return null;
		const node = graph.nodes.find((n) => n.id === selectedId);
		return toRouteSelection(selectedRoute, cursor, node?.domain);
	}, [graph, selectedRoute, selectedId, cursor]);
	const activeRoute = routeSelection ?? route;

	// Route selection: just marks the frame dirty (like settings).
	useEffect(() => {
		rendererRef.current?.setRoute(activeRoute);
	}, [activeRoute, canvasData, isEmpty, storedLoaded]);

	// The camera follows the cursor when its node is off-screen.
	const cursorNodeId = cursor?.node ? `work:${cursor.node}` : null;
	useEffect(() => {
		if (cursorNodeId) rendererRef.current?.panIntoView(cursorNodeId);
	}, [cursorNodeId]);

	// The pane docks beside the canvas, so opening or resizing it narrows the
	// canvas: once the renderer has re-fitted (its ResizeObserver runs after
	// the frame's layout), nudge the camera so the shown node stays in view.
	const shownNodeRef = useRef<string | null>(null);
	const nudgeToShown = useCallback(() => {
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const id = shownNodeRef.current;
				if (id) rendererRef.current?.panIntoView(id);
			}),
		);
	}, []);
	// Feed #2 — settings: just marks the frame dirty. No rebuild, no
	// re-layout, no camera touch. `isEmpty` in the deps: the renderer is
	// created by an effect keyed on it, so the load-time run must re-fire.
	const deferredSettings = useDeferredValue(settings);
	useEffect(() => {
		rendererRef.current?.setSettings(deferredSettings);
	}, [deferredSettings, isEmpty]);

	// Feed #3 — visibility: hidden nodes drop out of rendering, picking,
	// hover, AND labels; edges drop when either endpoint is hidden.
	useEffect(() => {
		rendererRef.current?.setVisible(query.trim() ? visibleIds : null);
		// The open detail card cannot outlive its node's visibility.
		setSelected((sel) => (sel && visibleIds.has(sel.id) ? sel : null));
	}, [visibleIds, query]);

	// Feed #4/#5 — region and physics tuning (physics rebuilds the live sim
	// in place: drag pins survive, a mid-settle change re-anneals).
	const regionTuning = settings.regions;
	const physicsTuning = settings.physics;
	useEffect(() => {
		rendererRef.current?.setRegionTuning(regionTuning);
	}, [regionTuning, isEmpty]);
	useEffect(() => {
		rendererRef.current?.setPhysicsTuning(physicsTuning);
	}, [physicsTuning, isEmpty]);

	// Programmatic focus: frame the node(s), then open its pane.
	const focusNode = useCallback((nodeId: string): boolean => {
		const renderer = rendererRef.current;
		if (!renderer || !renderer.focusOn([nodeId], 3)) return false;
		setSelected({ id: nodeId });
		return true;
	}, []);
	const focusNodes = useCallback((ids: string[], anchorId: string) => {
		const renderer = rendererRef.current;
		if (!renderer || !renderer.focusOn(ids, 2.5)) return;
		setSelected({ id: anchorId });
	}, []);
	const focusNodeRef = useRef(focusNode);
	focusNodeRef.current = focusNode;
	useEffect(() => {
		if (!controllerRef) return;
		controllerRef.current = {
			renderer: () => rendererRef.current,
			focusNode: (id) => focusNodeRef.current(id),
		};
		return () => {
			controllerRef.current = null;
		};
	}, [controllerRef]);

	// The focus param: act once the data feed has handed the renderer its
	// nodes (declared after the feeds, so it runs after them in a commit).
	// A node the search hides clears the search first; a canvas that isn't
	// sized yet is retried for a few frames. onFocusHandled fires only once
	// the focus actually landed (or the retries ran out).
	const onFocusHandledRef = useRef(onFocusHandled);
	onFocusHandledRef.current = onFocusHandled;
	const hiddenBySearch = !!focusId && query.trim() !== "" && !visibleIds.has(focusId);
	useEffect(() => {
		if (!focusId || isEmpty || !storedLoaded) return;
		if (hiddenBySearch) {
			setQuery("");
			return;
		}
		let frames = 0;
		let raf = 0;
		const attempt = () => {
			if (focusNodeRef.current(focusId)) {
				onFocusHandledRef.current?.(focusId);
				return;
			}
			if (++frames > 60) {
				onFocusHandledRef.current?.(focusId); // give up; clear the param
				return;
			}
			raf = requestAnimationFrame(attempt);
		};
		attempt();
		return () => cancelAnimationFrame(raf);
	}, [focusId, isEmpty, storedLoaded, canvasData, hiddenBySearch]);

	// ---- The Work view's split --------------------------------------------
	// The table (a left column over this page) selects THROUGH the graph's own selection: a request becomes
	// setSelected, so the route, the physics and the pane follow exactly as for a click on the map. The route the
	// table lights is published back from this same computation.
	const work = useWorkView();
	const workSel = work.selection;
	const workSelRef = useRef(workSel);
	workSelRef.current = workSel;
	const handledSeq = useRef<number | null>(null);
	useEffect(() => {
		if (!workSel) {
			// The table is back to full screen: the graph's selection goes with it.
			if (handledSeq.current !== null) setSelected(null);
			handledSeq.current = null;
			return;
		}
		if (handledSeq.current === workSel.seq || isEmpty || !storedLoaded) return;
		const gid = `work:${workSel.id}`;
		if (!graph.nodes.some((n) => n.id === gid)) return;
		handledSeq.current = workSel.seq;
		setSelected({ id: gid });
		// The column narrows the canvas first; pan once the renderer has re-fitted.
		requestAnimationFrame(() => requestAnimationFrame(() => rendererRef.current?.focusOn([gid], 3)));
	}, [workSel, graph, isEmpty, storedLoaded]);
	// Closing the pane (X or Esc) while the table is split returns the table to full screen.
	const hadSelected = useRef(false);
	useEffect(() => {
		if (hadSelected.current && selectedId === null && workSelRef.current) work.clearSelection();
		hadSelected.current = selectedId !== null;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedId]);
	const publishRoute = work.publishRoute;
	useEffect(() => {
		const raw = selectedId ? rawWorkId(selectedId) : null;
		publishRoute(raw ? workRouteView(selectedRoute, raw, cursor?.node ?? null) : null);
	}, [publishRoute, selectedId, selectedRoute, cursor?.node]);
	useEffect(() => () => publishRoute(null), [publishRoute]);
	// The column covers the page's left edge: inset the graph past it so the canvas (and its fit) is the visible part.
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [inset, setInset] = useState(0);
	const splitWidth = workSel ? work.colWidth : 0;
	useEffect(() => {
		const left = rootRef.current?.getBoundingClientRect().left ?? 0;
		setInset(Math.max(0, splitWidth - left));
	}, [splitWidth]);

	// The pane's details follow the route cursor's node (when a route is selected).
	const card = useMemo(
		() => (selected ? (describeNode(graph, cursorNodeId ?? selected.id) ?? describeNode(graph, selected.id)) : null),
		[graph, selected, cursorNodeId],
	);
	const routeNav = useMemo<RouteNavModel | null>(() => {
		if (!selectedRoute || !cursor) return null;
		const byRaw = new Map(graph.nodes.map((n) => [rawWorkId(n.id) ?? "", n] as const));
		return {
			route: selectedRoute,
			cursor,
			label: (id) => byRaw.get(id)?.label ?? id,
			stage: (id) => byRaw.get(id)?.stage ?? "",
			onCursor: (next) => setCursorState({ id: selectedId!, cursor: next }),
		};
	}, [graph, selectedRoute, cursor, selectedId]);
	shownNodeRef.current = card?.id ?? null;

	return (
		<div ref={rootRef} className="flex h-full w-full" style={inset > 0 ? { paddingLeft: inset } : undefined}>
			<div className="relative h-full min-w-0 flex-1">
				{isEmpty ? (
					<div className="flex h-full w-full items-center justify-center px-4">
						<div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
							<WaypointsIcon className="size-10 opacity-40" strokeWidth={1.25} />
							<div className="text-lg font-medium text-foreground">Nothing to show</div>
							<p className="max-w-sm text-sm">
								{graph.domain
									? `The ${graph.domain} domain has no nodes in this view. Clear the domain filter in the display settings.`
									: "The knowledge base has no nodes yet."}
							</p>
						</div>
					</div>
				) : (
					<div ref={containerRef} className="relative h-full w-full">
						{/* THE single canvas: every layer (regions, edges, nodes, both
						    label systems, hover) draws into it, once per frame. */}
						<canvas ref={canvasRef} className="block h-full w-full touch-none" />
					</div>
				)}

				{/* Top-right controls — floating containers. lh-no-drag: home's
				    floating drag strip underlays this row — Electron's drag mask
				    ignores z-index, so without an explicit carve-out the controls
				    were unclickable in the desktop app. The row NEVER wraps; in
				    narrow windows the search shrinks. */}
				<div className="lh-no-drag lh-wco-floating absolute right-2 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-col items-end gap-2">
					<div className="relative z-20 flex min-w-0 items-start gap-2">
						<GraphChromeRow
							isEmpty={isEmpty}
							query={query}
							onQuery={setQuery}
							noMatch={!isEmpty && visibleIds.size === 0 && query.trim() !== ""}
							searchInputRef={searchInputRef}
							settings={settings}
							changeSettings={changeSettings}
							domains={graph.domains}
						/>
					</div>
				</div>

				{overlayId && (
					<FeatureTaskOverlay
						graph={graph}
						featureId={overlayId}
						onClose={() => setOverlayId(null)}
						onSelectNode={(id) => {
							setOverlayId(null);
							focusNodeRef.current(id);
						}}
					/>
				)}
			</div>
			{selected && card && !isEmpty && (
				<GraphPane
					card={card}
					routeNav={routeNav}
					onClose={() => setSelected(null)}
					onFocus={(ids) => focusNodes(ids, card.id)}
					onSelectNode={(id) => focusNodeRef.current(id)}
					onNavigate={(href) => router.push(href)}
					onLayout={nudgeToShown}
				/>
			)}
		</div>
	);
}
