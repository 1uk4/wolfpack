import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CheckIcon, FocusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GraphData, GraphNodeStatus } from "@wolfpack/protocol/objects";
import { CLICK_SLOP } from "@/components/graph-canvas";
import { layoutGraph } from "@/src/core";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const STATUS_LABEL: Record<GraphNodeStatus, string> = { todo: "To do", doing: "Doing", done: "Done", blocked: "Blocked", skipped: "Skipped" };
const CARD: Record<GraphNodeStatus, string> = {
	todo: "border-border bg-card text-foreground",
	doing: "border-sky-400 bg-sky-400/10 text-foreground",
	done: "border-emerald-500/60 bg-emerald-500/10 text-muted-foreground",
	blocked: "border-dashed border-red-400 bg-red-400/10 text-foreground",
	skipped: "border-border bg-muted/40 text-muted-foreground opacity-60",
};
const DOT: Record<GraphNodeStatus, string> = {
	todo: "border border-muted-foreground/60",
	doing: "bg-sky-400",
	done: "bg-emerald-500",
	blocked: "bg-red-400",
	skipped: "bg-muted-foreground/40",
};

/**
 * THE SHARED GRAPH VIEW: a layered DAG (prerequisites left, dependents right), status-coloured; scrolls sideways when
 * wide. Drawn by the show_graph chat card (PlanGraphCard, fixed, full labels) and the pinned feature graph. `onNodeClick`
 * turns each node into a button; `highlightId` makes one node glow (the thread's bound task).
 *
 * `draggable` makes it a FREE-PAN CANVAS like the Knowledge graph's feel (same click slop, grab / grabbing cursor, no
 * zoom, no node drag): dragging the background moves the graph with NO clamp at the edges, it starts centred on the
 * highlighted node (else the whole graph), and a small re-center button puts it back. A press that travels more than the
 * slop is never a node click. `fill` makes the box fill its parent (the full-screen modal) instead of being as tall as
 * the graph up to the panel cap. `collapseDone` draws done and skipped nodes as thin label-less bars (title on hover,
 * aria-label), packed tighter by the layout; the highlighted node always stays a full card. `toolbar` is extra
 * controls placed beside the re-center button.
 */
export function PlanGraphView({
	graph,
	onNodeClick,
	highlightId,
	label,
	draggable = false,
	collapseDone = false,
	fill = false,
	toolbar,
}: {
	graph: GraphData;
	onNodeClick?: (id: string) => void;
	highlightId?: string | null;
	label?: string;
	draggable?: boolean;
	collapseDone?: boolean;
	fill?: boolean;
	toolbar?: ReactNode;
}) {
	const pan = usePan(draggable);
	const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const slim = new Set(collapseDone ? graph.nodes.filter((n) => (n.status === "done" || n.status === "skipped") && n.id !== highlightId).map((n) => n.id) : []);
	const layout = layoutGraph(graph.nodes, graph.edges, { slim });
	const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label] as const));
	const dependsOn = new Map<string, string[]>();
	for (const e of graph.edges) {
		const dep = labelOf.get(e.to);
		if (dep === undefined || !labelOf.has(e.from)) continue;
		const list = dependsOn.get(e.from) ?? [];
		list.push(dep);
		dependsOn.set(e.from, list);
	}
	const at = new Map(layout.nodes.map((p) => [p.id, p] as const));
	const done = graph.nodes.filter((n) => n.status === "done").length;
	const centreOffset = () => {
		const box = pan.ref.current;
		const vw = box?.clientWidth || 0;
		const vh = box?.clientHeight || 0;
		const hi = highlightId ? at.get(highlightId) : undefined;
		if (hi) return { x: Math.round(vw / 2 - (hi.x + hi.width / 2)), y: Math.round(vh / 2 - (hi.y + hi.height / 2)) };
		// the whole graph: centred when it fits an axis, else its start is at the edge
		return { x: layout.width <= vw ? Math.round((vw - layout.width) / 2) : 0, y: layout.height <= vh ? Math.round((vh - layout.height) / 2) : 0 };
	};
	const centreRef = useRef(centreOffset);
	centreRef.current = centreOffset;
	useIsoLayoutEffect(() => {
		if (draggable) pan.setOffset(centreRef.current());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draggable]);
	const clickNode = (id: string) => {
		if (!pan.consumeDrag()) onNodeClick?.(id);
	};
	return (
		<div
			className={draggable ? cn("relative touch-none select-none overflow-hidden", fill ? "h-full" : "max-h-[calc(40vh-1.5rem)]", pan.dragging ? "cursor-grabbing" : "cursor-grab") : "overflow-x-auto pb-1"}
			style={draggable && !fill ? { height: layout.height } : undefined}
			data-testid="graph-scroll"
			data-draggable={draggable ? "true" : undefined}
			{...pan.handlers}
			ref={pan.ref}
		>
			<div className="relative" style={draggable ? { transform: `translate(${pan.offset.x}px, ${pan.offset.y}px)`, width: layout.width, height: layout.height } : undefined} data-testid="graph-pan" data-pan-x={pan.offset.x} data-pan-y={pan.offset.y}>
				<div className="relative" role="group" aria-label={`${label ?? `Plan graph${graph.title ? `: ${graph.title}` : ""}`}, ${graph.nodes.length} nodes, ${done} done`} style={{ width: layout.width, height: layout.height }}>
					<svg className="pointer-events-none absolute inset-0 text-muted-foreground" width={layout.width} height={layout.height} aria-hidden>
						<defs>
							<marker id={`arrow-${uid}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
								<path d="M0 0L8 4L0 8z" fill="currentColor" />
							</marker>
						</defs>
						{layout.edges.map((e) => {
							const mid = (e.x1 + e.x2) / 2;
							return (
								<path
									key={`${e.from}->${e.to}`}
									data-testid="graph-edge"
									data-from={e.from}
									data-to={e.to}
									d={`M${e.x1} ${e.y1}C${mid} ${e.y1} ${mid} ${e.y2} ${e.x2} ${e.y2}`}
									fill="none"
									stroke="currentColor"
									strokeWidth={1.25}
									opacity={0.6}
									markerEnd={`url(#arrow-${uid})`}
								/>
							);
						})}
					</svg>
					<ul role="list" className="m-0 list-none p-0">
						{graph.nodes.map((n) => {
							const p = at.get(n.id);
							if (!p) return null;
							const hi = highlightId === n.id;
							const sliver = slim.has(n.id);
							const name = `${n.label} (${STATUS_LABEL[n.status]}${hi ? ", current" : ""})`;
							return (
								<li
									key={n.id}
									data-testid="graph-node"
									data-node-id={n.id}
									data-status={n.status}
									data-kind={n.kind}
									data-rank={p.rank}
									data-highlight={hi ? "true" : "false"}
									data-sliver={sliver ? "true" : undefined}
									title={n.detail ? `${n.label} — ${n.detail}` : n.label}
									aria-label={sliver ? name : undefined}
									className={cn(
										sliver ? (n.status === "done" ? "absolute rounded-full bg-emerald-500/70" : "absolute rounded-full bg-muted-foreground/40") : "absolute flex flex-col gap-1 overflow-hidden rounded-lg border px-2.5 py-1.5",
										!sliver && CARD[n.status],
										hi && "border-yellow-400 shadow-[0_0_10px_1px_rgba(250,204,21,0.45)] ring-1 ring-yellow-400/70",
									)}
									style={{ left: p.x, top: p.y, width: p.width, height: p.height }}
								>
									{!sliver && (
										<>
											<div className="flex items-center gap-1.5 text-[10px] leading-none">
												{n.status === "done" ? <CheckIcon className="size-3 shrink-0 text-emerald-500" aria-hidden /> : <span className={cn("size-2 shrink-0 rounded-full", DOT[n.status])} aria-hidden />}
												<span className="font-medium">{STATUS_LABEL[n.status]}</span>
												<span className="ml-auto truncate text-muted-foreground/80" title={n.kind}>
													{n.kind}
												</span>
											</div>
											<div className={cn("line-clamp-2 break-words text-xs leading-4", n.status === "skipped" && "line-through")}>{n.label}</div>
											{dependsOn.has(n.id) && <span className="sr-only">depends on: {dependsOn.get(n.id)!.join(", ")}</span>}
										</>
									)}
									{onNodeClick && (
										<button
											type="button"
											data-testid="graph-node-hit"
											aria-label={name}
											title={sliver ? n.label : undefined}
											onClick={() => clickNode(n.id)}
											className={cn("absolute cursor-pointer focus-visible:outline-2 focus-visible:outline-ring", sliver ? "-inset-x-0.5 -inset-y-1 rounded-full" : "inset-0 rounded-lg")}
										/>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			</div>
			{draggable && (
				<div className="absolute right-1 top-1 z-10 flex items-center gap-1" data-testid="graph-toolbar" onPointerDown={(e) => e.stopPropagation()}>
					{toolbar}
					<button
						type="button"
						data-testid="graph-recenter"
						aria-label="Re-center graph"
						title="Re-center graph"
						onClick={() => pan.setOffset(centreOffset())}
						className="inline-flex size-6 items-center justify-center rounded-md border bg-card/90 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
					>
						<FocusIcon className="size-3.5" aria-hidden />
					</button>
				</div>
			)}
		</div>
	);
}

/**
 * Drag-to-pan state for the draggable view. Pointer events on the box; the pointer is captured only once it travels past
 * CLICK_SLOP, so a plain press still reaches the node button as a click, and a press that became a drag is swallowed
 * (`consumeDrag`). The offset is NOT clamped: the canvas pans freely past the graph's edges.
 */
function usePan(enabled: boolean) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [offset, setOffset] = useState({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const press = useRef<{ x: number; y: number; ox: number; oy: number; id: number } | null>(null);
	const moved = useRef(false);
	const pressSeq = useRef(0);
	const handlers = enabled
		? {
				onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
					if (e.button !== 0) return;
					moved.current = false;
					pressSeq.current++;
					press.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y, id: e.pointerId };
				},
				onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
					const p = press.current;
					if (!p) return;
					if (e.buttons === 0) {
						press.current = null;
						setDragging(false);
						return;
					}
					if (e.pointerId !== p.id) return;
					const dx = e.clientX - p.x;
					const dy = e.clientY - p.y;
					if (!moved.current) {
						if (Math.hypot(dx, dy) <= CLICK_SLOP) return;
						moved.current = true;
						setDragging(true);
						try {
							e.currentTarget.setPointerCapture(p.id);
						} catch {
							/* capture is best-effort */
						}
					}
					setOffset({ x: p.ox + dx, y: p.oy + dy });
				},
				onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
					if (!press.current) return;
					try {
						e.currentTarget.releasePointerCapture(press.current.id);
					} catch {
						/* already released */
					}
					press.current = null;
					setDragging(false);
					// the click that ends a real drag never comes when the release is off the node: do not leave `moved` set
					const seq = pressSeq.current;
					setTimeout(() => {
						if (pressSeq.current === seq) moved.current = false; // not if a new press began meanwhile
					}, 0);
				},
				onPointerCancel: () => {
					press.current = null;
					moved.current = false;
					setDragging(false);
				},
			}
		: {};
	/** True (once) when the press that ends in this click was a drag. */
	const consumeDrag = () => {
		const was = moved.current;
		moved.current = false;
		return was;
	};
	return { ref, offset, setOffset, dragging, handlers, consumeDrag };
}
