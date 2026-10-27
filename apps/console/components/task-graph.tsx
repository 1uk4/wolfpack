"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Handle, MarkerType, Position, ReactFlow, Controls, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { CheckIcon, MaximizeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OverlayShell } from "@/components/overlay-shell";
import { layoutTaskGraph, type TaskGraphModel, type TaskNode, type TaskStatus } from "@/src/core";

type GraphModel = Extract<TaskGraphModel, { kind: "graph" }>;

/**
 * The feature's task graph, drawn by React Flow (HTML cards, so titles wrap
 * and clamp; real edges; pan/zoom) over the pure placement in
 * src/core/task-graph-layout (dagre per connected component, chains stacked,
 * single tasks packed into a wrapped grid). Status → look: shipped = muted +
 * check; building = sky border + dot; ready = normal; blocked = dashed;
 * archived = faded. The bound task wears a yellow ring and "current". Edges
 * run dependency → dependent.
 */

const STATUS_LABEL: Record<TaskStatus, string> = { shipped: "Shipped", building: "In build", ready: "Ready", blocked: "Blocked", archived: "Archived" };
const LEGEND: TaskStatus[] = ["building", "ready", "blocked", "shipped"];

const CARD: Record<TaskStatus, string> = {
	shipped: "border-border bg-muted/60 text-muted-foreground",
	building: "border-sky-400 bg-card text-foreground",
	ready: "border-foreground/40 bg-card text-foreground",
	blocked: "border-dashed border-border bg-card/60 text-muted-foreground",
	archived: "border-border bg-card/40 text-muted-foreground opacity-50",
};
const DOT: Record<TaskStatus, string> = {
	shipped: "bg-muted-foreground/60",
	building: "bg-sky-400",
	ready: "bg-foreground/60",
	blocked: "border border-muted-foreground/60",
	archived: "bg-muted-foreground/30",
};

export interface TaskNodeView {
	id: string;
	title: string;
	status: TaskStatus;
	statusLabel: string;
	kind: string;
	bound: boolean;
	ariaLabel: string;
	cardClass: string;
	dotClass: string;
}

/** Everything a card shows, derived (pure). */
export function taskNodeView(n: Pick<TaskNode, "id" | "title" | "kind" | "status">, bound: boolean): TaskNodeView {
	const statusLabel = STATUS_LABEL[n.status];
	return {
		id: n.id,
		title: n.title,
		status: n.status,
		statusLabel,
		kind: n.kind,
		bound,
		ariaLabel: `${n.title} (${statusLabel.toLowerCase()}${bound ? ", current task" : ""})`,
		cardClass: `${CARD[n.status]}${bound ? " ring-2 ring-yellow-400/80 shadow-[0_0_14px_2px_rgba(250,204,21,0.35)]" : ""}`,
		dotClass: DOT[n.status],
	};
}

/** Keys that activate a focused node (button semantics). */
export const isActivateKey = (key: string): boolean => key === "Enter" || key === " ";

interface CardData extends Record<string, unknown> {
	view: TaskNodeView;
	onSelect?: (id: string) => void;
}

/** One task card (also rendered alone in tests). */
export function TaskCard({ view, onSelect }: { view: TaskNodeView; onSelect?: (id: string) => void }) {
	return (
		<div
			data-testid={`task-node-${view.id}`}
			data-status={view.status}
			data-bound={view.bound ? "true" : "false"}
			className={`nopan pointer-events-auto flex h-full w-full flex-col gap-1.5 rounded-lg border px-3 py-3 font-sans outline-none focus-visible:ring-2 focus-visible:ring-ring ${onSelect ? "cursor-pointer" : ""} ${view.cardClass}`}
			role={onSelect ? "button" : undefined}
			tabIndex={onSelect ? 0 : undefined}
			aria-label={onSelect ? view.ariaLabel : undefined}
			onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(view.id); } : undefined}
			onKeyDown={
				onSelect
					? (e) => {
							if (isActivateKey(e.key)) {
								e.preventDefault();
								e.stopPropagation();
								onSelect(view.id);
							}
						}
					: undefined
			}
		>
			<div className="flex h-5 items-center gap-1.5 text-[11px] leading-none">
				{view.status === "shipped" ? <CheckIcon className="size-3.5 shrink-0" aria-hidden data-check="true" /> : <span className={`size-2 shrink-0 rounded-full ${view.dotClass}`} aria-hidden />}
				<span className="font-medium">{view.statusLabel}</span>
				{view.bound ? <span className="rounded bg-yellow-400/20 px-1 py-0.5 font-medium text-yellow-600 dark:text-yellow-300" data-testid="task-current">current</span> : null}
				<span className="ml-auto text-muted-foreground/70">{view.kind}</span>
			</div>
			<div className="line-clamp-3 break-words text-[13px] leading-[18px]" title={view.title}>
				{view.title}
			</div>
		</div>
	);
}

function TaskFlowNode({ data }: NodeProps<Node<CardData>>) {
	return (
		<>
			<Handle type="target" position={Position.Top} isConnectable={false} style={{ opacity: 0, pointerEvents: "none" }} />
			<TaskCard view={data.view} onSelect={data.onSelect} />
			<Handle type="source" position={Position.Bottom} isConnectable={false} style={{ opacity: 0, pointerEvents: "none" }} />
		</>
	);
}
const nodeTypes = { task: TaskFlowNode };

/** React Flow's chrome follows the console tokens. */
const FLOW_STYLE = {
	background: "transparent",
	"--xy-controls-button-background-color-default": "var(--card)",
	"--xy-controls-button-background-color-hover-default": "var(--accent)",
	"--xy-controls-button-color-default": "var(--foreground)",
	"--xy-controls-button-color-hover-default": "var(--foreground)",
	"--xy-controls-button-border-color-default": "var(--border)",
	"--xy-attribution-background-color-default": "transparent",
} as CSSProperties;

const NODE_W_COMPACT = 220;
const NODE_W_OVERLAY = 220;
const COMPACT_MAX_H = 420;

function useFlow(model: GraphModel, nodeWidth: number, maxWidth: number, onSelect: ((id: string) => void) | undefined) {
	const layout = useMemo(() => layoutTaskGraph(model.nodes, model.edges, { nodeWidth, maxWidth }), [model.nodes, model.edges, nodeWidth, maxWidth]);
	const nodes = useMemo<Node<CardData>[]>(() => {
		const byId = new Map(model.nodes.map((n) => [n.id, n] as const));
		return layout.nodes.map((p) => ({
			id: p.id,
			type: "task",
			position: { x: p.x, y: p.y },
			width: p.w,
			height: p.h,
			data: { view: taskNodeView(byId.get(p.id)!, p.id === model.boundId), onSelect },
			draggable: false,
			connectable: false,
			selectable: false,
			focusable: false,
		}));
	}, [layout, model.nodes, model.boundId, onSelect]);
	const edges = useMemo<Edge[]>(() => {
		const status = new Map(model.nodes.map((n) => [n.id, n.status] as const));
		return model.edges.map((e) => {
			const live = status.get(e.to) === "building" || status.get(e.to) === "ready";
			const color = live ? "var(--foreground)" : "var(--muted-foreground)";
			const dim = status.get(e.from) === "archived" || status.get(e.to) === "archived";
			return {
				id: `${e.from}->${e.to}`,
				source: e.from,
				target: e.to,
				type: "smoothstep",
				focusable: false,
				selectable: false,
				markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
				style: { stroke: color, strokeWidth: 1.5, opacity: dim ? 0.3 : live ? 0.85 : 0.55 },
			};
		});
	}, [model.nodes, model.edges]);
	return { layout, nodes, edges };
}

/** Panel-width graph: not zoomable (the panel scrolls), fitted to the panel, nodes clickable; Expand opens the overlay. */
export function TaskGraph({ model, onSelect }: { model: GraphModel; onSelect: (id: string) => void }) {
	const [overlay, setOverlay] = useState(false);
	const expandRef = useRef<HTMLButtonElement>(null);
	const close = () => {
		setOverlay(false);
		// focus returns to the Expand button once the overlay is gone
		requestAnimationFrame(() => expandRef.current?.focus());
	};
	return (
		<div className="relative" data-testid="task-graph">
			<TaskGraphCompact model={model} onSelect={onSelect} />
			<Button ref={expandRef} size="icon-xs" variant="outline" className="absolute right-0 top-0 z-10" aria-label="Expand task graph" data-testid="task-graph-expand" onClick={() => setOverlay(true)}>
				<MaximizeIcon />
			</Button>
			{overlay ? (
				<TaskGraphOverlay
					model={model}
					onClose={close}
					onSelect={(id) => {
						setOverlay(false);
						onSelect(id);
					}}
				/>
			) : null}
		</div>
	);
}

export function TaskGraphCompact({ model, onSelect }: { model: GraphModel; onSelect?: (id: string) => void }) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(300);
	useEffect(() => {
		const el = wrapRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth || 300));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const { layout, nodes, edges } = useFlow(model, NODE_W_COMPACT, width, onSelect);
	const scale = Math.min(1, (width - 8) / Math.max(layout.width, 1));
	const height = Math.round(Math.min(COMPACT_MAX_H, Math.max(96, layout.height * scale + 16)));
	return (
		<div ref={wrapRef} style={{ height }} className="w-full" role="group" aria-label={`Task graph: ${model.featureTitle}, ${model.label}`} data-testid="task-graph-svg">
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				style={FLOW_STYLE}
				width={width}
				height={height}
				fitView
				fitViewOptions={{ padding: 0.04, maxZoom: 1 }}
				minZoom={0.1}
				maxZoom={1}
				nodesDraggable={false}
				nodesConnectable={false}
				nodesFocusable={false}
				edgesFocusable={false}
				elementsSelectable={false}
				panOnDrag={false}
				panOnScroll={false}
				zoomOnScroll={false}
				zoomOnPinch={false}
				zoomOnDoubleClick={false}
				preventScrolling={false}
				proOptions={{ hideAttribution: true }}
			/>
		</div>
	);
}

/** Full-screen view with pan/zoom + Controls. Esc closes (one Esc, one action). */
export function TaskGraphOverlay({ model, onClose, onSelect }: { model: GraphModel; onClose: () => void; onSelect: (id: string) => void }) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(1000);
	useEffect(() => {
		const el = viewportRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		setWidth(el.clientWidth || 1000);
		const ro = new ResizeObserver(() => setWidth(el.clientWidth || 1000));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const { nodes, edges } = useFlow(model, NODE_W_OVERLAY, width - 48, onSelect);

	return (
		<OverlayShell
			label={`Task graph: ${model.featureTitle}`}
			testId="task-graph-overlay"
			closeTestId="task-graph-close"
			onClose={onClose}
			header={(close) => (
				<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
					<span className="font-sans text-sm font-medium">{model.featureTitle}</span>
					<span className="text-xs text-muted-foreground">{model.label}</span>
					<ul className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground" aria-label="Legend">
						{LEGEND.map((s) => (
							<li key={s} className="flex items-center gap-1">
								{s === "shipped" ? <CheckIcon className="size-3" aria-hidden /> : <span className={`size-2 rounded-full ${DOT[s]}`} aria-hidden />}
								{STATUS_LABEL[s]}
							</li>
						))}
						{model.boundId ? <li className="flex items-center gap-1"><span className="size-2 rounded-full ring-2 ring-yellow-400/80" aria-hidden />Current</li> : null}
					</ul>
					{close}
				</div>
			)}
		>
			<div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-background">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					style={FLOW_STYLE}
					fitView
					fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
					minZoom={0.1}
					maxZoom={2}
					nodesDraggable={false}
					nodesConnectable={false}
					nodesFocusable={false}
					edgesFocusable={false}
					elementsSelectable={false}
					proOptions={{ hideAttribution: true }}
				>
					<Controls showInteractive={false} position="bottom-right" />
				</ReactFlow>
			</div>
		</OverlayShell>
	);
}
