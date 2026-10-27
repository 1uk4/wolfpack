"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MaximizeIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "@/components/pan-zoom";
import {
	ARROW_HEAD,
	GLOW_BLUR,
	GLOW_MARGIN,
	GLOW_REACH,
	LINE_H,
	NODE_H,
	NODE_W_MIN,
	STROKE_W,
	blockLayout,
	edgePathD,
	wrapTitle,
} from "@/components/plan-block";
import type { TaskGraphModel, TaskStatus } from "@/src/core";

type GraphModel = Extract<TaskGraphModel, { kind: "graph" }>;

/**
 * The feature's task graph: a dagre top-down layout (the learnharness plan
 * block's engine and geometry, via components/plan-block) drawn as SVG.
 * Status → look: shipped = filled bright + check; building = sky stroke;
 * ready = normal; blocked = muted + dashed; archived = dimmed. The bound
 * task carries a blurred yellow glow. Edges run dependency → dependent.
 */
const BOX: Record<TaskStatus, string> = {
	shipped: "fill-foreground/20 stroke-foreground",
	building: "fill-background/50 stroke-sky-400",
	ready: "fill-background/50 stroke-foreground/70",
	blocked: "fill-card stroke-border",
	archived: "fill-card stroke-border",
};
const TEXT: Record<TaskStatus, string> = {
	shipped: "fill-foreground text-xs font-medium",
	building: "fill-foreground text-xs",
	ready: "fill-foreground text-xs",
	blocked: "fill-muted-foreground/80 text-xs",
	archived: "fill-muted-foreground/60 text-xs",
};
const CHECK = "M0 5 L4 9 L12 0";

export function TaskGraphSvg({
	model,
	onSelect,
	naturalSize,
}: {
	model: GraphModel;
	onSelect?: (id: string) => void;
	/** Render at the viewBox size in px (the overlay's pan/zoom math needs 1 unit = 1 px). */
	naturalSize?: boolean;
}) {
	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const layout = useMemo(() => blockLayout(model.nodes, model.edges), [model.nodes, model.edges]);
	const pad = GLOW_REACH;
	const ox = layout.originX ?? 0;
	const oy = layout.originY ?? 0;
	const vbW = Math.max(layout.width, 1) + 2 * pad;
	const vbH = Math.max(layout.height, 1) + 2 * pad;
	const statusOf = new Map(model.nodes.map((n) => [n.id, n.status] as const));
	const headH = 16 * (STROKE_W / 1.5);
	const headW = (50.2 * headH) / 104;
	return (
		<svg
			viewBox={`${ox - pad} ${oy - pad} ${vbW} ${vbH}`}
			className={`block h-auto ${naturalSize ? "" : "w-full"}`}
			style={naturalSize ? { width: `${vbW}px` } : undefined}
			role="img"
			aria-label={`Task graph: ${model.featureTitle}`}
			data-testid="task-graph-svg"
		>
			<defs>
				<marker id={markerId} viewBox="0 0 50.2 104" refX={27.2} refY={52} markerWidth={headW} markerHeight={headH} markerUnits="userSpaceOnUse" orient="auto">
					<path d={ARROW_HEAD} className="fill-muted-foreground" />
				</marker>
				<filter id={`${markerId}-glow`} x="-60%" y="-60%" width="220%" height="220%">
					<feGaussianBlur stdDeviation={GLOW_BLUR} />
				</filter>
			</defs>
			{model.edges.map((e) => {
				const pts = layout.edgePts.get(`${e.from}->${e.to}`);
				if (!pts) return null;
				const tx = layout.x.get(e.to);
				const ty = layout.y.get(e.to);
				const target = tx !== undefined && ty !== undefined ? { x: tx, y: ty, w: layout.nodeW.get(e.to) ?? NODE_W_MIN, h: layout.nodeH.get(e.to) ?? NODE_H } : undefined;
				const dim = statusOf.get(e.from) === "archived" || statusOf.get(e.to) === "archived";
				return (
					<path
						key={`${e.from}->${e.to}`}
						d={edgePathD(pts, target)}
						className={`fill-none stroke-muted-foreground${dim ? " opacity-40" : ""}`}
						strokeWidth={STROKE_W}
						markerEnd={`url(#${markerId})`}
						data-edge={`${e.from}->${e.to}`}
					/>
				);
			})}
			{model.nodes.map((n) => {
				const lines = wrapTitle(n.title);
				const h = layout.nodeH.get(n.id) ?? NODE_H;
				const w = layout.nodeW.get(n.id) ?? NODE_W_MIN;
				const y0 = (h - lines.length * LINE_H) / 2 + 10;
				const bound = n.id === model.boundId;
				return (
					<g
						key={n.id}
						transform={`translate(${layout.x.get(n.id) ?? 0}, ${layout.y.get(n.id) ?? 0})`}
						data-testid={`task-node-${n.id}`}
						data-status={n.status}
						data-bound={bound ? "true" : "false"}
						className={`${onSelect ? "cursor-pointer " : ""}${n.status === "archived" ? "opacity-40" : ""}`}
						role={onSelect ? "button" : undefined}
						tabIndex={onSelect ? 0 : undefined}
						aria-label={onSelect ? `${n.title} (${n.status})` : undefined}
						onClick={
							onSelect
								? (e) => {
										e.stopPropagation();
										onSelect(n.id);
									}
								: undefined
						}
						onKeyDown={
							onSelect
								? (e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											e.stopPropagation();
											onSelect(n.id);
										}
									}
								: undefined
						}
					>
						<rect width={w} height={h} className={BOX[n.status]} strokeWidth={n.status === "building" ? 2 : STROKE_W} strokeDasharray={n.status === "blocked" ? "4 3" : undefined} />
						{bound ? (
							<rect x={-GLOW_MARGIN} y={-GLOW_MARGIN} width={w + 2 * GLOW_MARGIN} height={h + 2 * GLOW_MARGIN} className="fill-yellow-400/25" filter={`url(#${markerId}-glow)`} data-glow="true" />
						) : null}
						{lines.map((line, i) => (
							<text key={i} x={w / 2} y={y0 + i * LINE_H} textAnchor="middle" className={TEXT[n.status]}>
								{line}
							</text>
						))}
						{n.status === "shipped" ? <path d={CHECK} transform={`translate(${w - 18}, 6)`} className="fill-none stroke-foreground" strokeWidth={1.5} data-check="true" /> : null}
					</g>
				);
			})}
		</svg>
	);
}

/** The graph at panel width; a node click selects it, any other click (or the expand button) opens the overlay. */
export function TaskGraph({ model, onSelect }: { model: GraphModel; onSelect: (id: string) => void }) {
	const [overlay, setOverlay] = useState(false);
	return (
		<div className="relative" data-testid="task-graph">
			<div className="cursor-zoom-in" onClick={() => setOverlay(true)}>
				<TaskGraphSvg model={model} onSelect={onSelect} />
			</div>
			<Button size="icon-xs" variant="ghost" className="absolute right-0 top-0" aria-label="Expand task graph" data-testid="task-graph-expand" onClick={() => setOverlay(true)}>
				<MaximizeIcon />
			</Button>
			{overlay ? (
				<TaskGraphOverlay
					model={model}
					onClose={() => setOverlay(false)}
					onSelect={(id) => {
						setOverlay(false);
						onSelect(id);
					}}
				/>
			) : null}
		</div>
	);
}

/** Larger view with pan/zoom (fit-floor semantics of components/pan-zoom). Esc closes (one Esc, one action). */
export function TaskGraphOverlay({ model, onClose, onSelect }: { model: GraphModel; onClose: () => void; onSelect: (id: string) => void }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const viewportRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const el = viewportRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const layout = useMemo(() => blockLayout(model.nodes, model.edges), [model.nodes, model.edges]);
	const box = useMemo(() => ({ w: Math.max(layout.width, 1) + 2 * GLOW_REACH, h: Math.max(layout.height, 1) + 2 * GLOW_REACH }), [layout]);
	const fitZoom = useMemo(() => fitZoomFor(box, size), [box, size]);
	const [view, setView] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
	const adjusted = useRef(false);
	const atFloor = view.zoom <= fitZoom + 1e-9;
	useEffect(() => {
		if (atFloor) adjusted.current = false;
	}, [atFloor]);
	useEffect(() => {
		if (adjusted.current || !size.w || !size.h) return;
		setView(fitGraphView(box, size, fitZoom));
	}, [fitZoom, size, box]);

	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
			const rect = el.getBoundingClientRect();
			setView((v) => zoomedGraphView(v, Math.exp(-dy * 0.0015), fitZoom, { x: e.clientX - rect.left, y: e.clientY - rect.top }, box, size));
			adjusted.current = true;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [fitZoom, box, size]);

	const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
	const stepZoom = (factor: number) => {
		adjusted.current = true;
		setView((v) => zoomedGraphView(v, factor, fitZoom, { x: size.w / 2, y: size.h / 2 }, box, size));
	};

	return (
		<div
			className="fixed inset-0 z-50 flex flex-col bg-background/80 p-4 backdrop-blur-sm"
			role="dialog"
			aria-modal="true"
			aria-label={`Task graph: ${model.featureTitle}`}
			data-testid="task-graph-overlay"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="mb-2 flex items-center gap-2">
				<span className="text-sm font-medium">{model.featureTitle}</span>
				<span className="text-xs text-muted-foreground">{model.label}</span>
				<Button size="icon-xs" variant="ghost" className="ml-auto" aria-label="Close" data-testid="task-graph-close" onClick={onClose}>
					<XIcon />
				</Button>
			</div>
			<div
				ref={viewportRef}
				className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-xl border ${atFloor ? "cursor-default" : "cursor-grab"}`}
				onPointerDown={(e) => {
					if (e.button !== 0 || atFloor) return;
					drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false };
					e.currentTarget.setPointerCapture(e.pointerId);
				}}
				onPointerMove={(e) => {
					const d = drag.current;
					if (!d) return;
					d.moved = true;
					setView((v) => (v.zoom <= fitZoom + 1e-9 ? v : { ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
				}}
				onPointerUp={() => {
					if (drag.current?.moved) adjusted.current = true;
					drag.current = null;
				}}
				onPointerCancel={() => {
					drag.current = null;
				}}
			>
				<div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
					<TaskGraphSvg model={model} onSelect={onSelect} naturalSize />
				</div>
				<div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-2">
					<span className="text-xs text-muted-foreground/60">Drag to pan · scroll to zoom</span>
					<div className="flex gap-1">
						<Button size="icon-xs" variant="outline" className="pointer-events-auto" aria-label="Zoom out" onClick={() => stepZoom(1 / 1.25)}>
							<MinusIcon />
						</Button>
						<Button
							size="icon-xs"
							variant="outline"
							className="pointer-events-auto"
							aria-label="Fit graph to screen"
							onClick={() => {
								adjusted.current = false;
								if (size.w && size.h) setView(fitGraphView(box, size, fitZoom));
							}}
						>
							<MaximizeIcon />
						</Button>
						<Button size="icon-xs" variant="outline" className="pointer-events-auto" aria-label="Zoom in" onClick={() => stepZoom(1.25)}>
							<PlusIcon />
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
