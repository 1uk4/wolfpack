import { useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GraphData, GraphNodeStatus } from "@wolfpack/protocol/objects";
import { CLICK_SLOP } from "@/components/graph-canvas";
import { layoutGraph } from "@/src/core";

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
 * wide. Drawn by the show_graph chat card (PlanGraphCard) and the pinned feature graph. `onNodeClick` turns each node
 * into a button; `highlightId` makes one node glow (the thread's bound task). `draggable` swaps the sideways scroll for a
 * drag-to-pan view like the Knowledge graph's (same click slop, grab / grabbing cursor, no zoom): the box is as tall as
 * the graph up to its container's max height, a drag moves the graph inside it, and a press that travels more than the
 * slop is never a node click. The KB viewer's node drag is its force simulation; this layout is fixed, so nodes stay put.
 */
export function PlanGraphView({ graph, onNodeClick, highlightId, label, draggable = false }: { graph: GraphData; onNodeClick?: (id: string) => void; highlightId?: string | null; label?: string; draggable?: boolean }) {
	const pan = usePan(draggable);
	const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const layout = layoutGraph(graph.nodes, graph.edges);
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
	const clickNode = (id: string) => {
		if (!pan.consumeDrag()) onNodeClick?.(id);
	};
	return (
		<div
			className={draggable ? cn("relative max-h-[calc(40vh-1.5rem)] touch-none select-none overflow-hidden", pan.dragging ? "cursor-grabbing" : "cursor-grab") : "overflow-x-auto pb-1"}
			style={draggable ? { height: layout.height } : undefined}
			data-testid="graph-scroll"
			data-draggable={draggable ? "true" : undefined}
			{...pan.handlers}
			ref={pan.ref}
		>
			<div className="relative" style={draggable ? { transform: `translate(${pan.view(layout.width, layout.height).x}px, ${pan.view(layout.width, layout.height).y}px)`, width: layout.width, height: layout.height } : undefined} data-testid="graph-pan" data-pan-x={pan.view(layout.width, layout.height).x} data-pan-y={pan.view(layout.width, layout.height).y}>
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
							return (
								<li
									key={n.id}
									data-testid="graph-node"
									data-node-id={n.id}
									data-status={n.status}
									data-kind={n.kind}
									data-rank={p.rank}
									data-highlight={hi ? "true" : "false"}
									title={n.detail ? `${n.label} — ${n.detail}` : n.label}
									className={cn("absolute flex flex-col gap-1 overflow-hidden rounded-lg border px-2.5 py-1.5", CARD[n.status], hi && "border-yellow-400 shadow-[0_0_10px_1px_rgba(250,204,21,0.45)] ring-1 ring-yellow-400/70")}
									style={{ left: p.x, top: p.y, width: layout.nodeWidth, height: layout.nodeHeight }}
								>
									<div className="flex items-center gap-1.5 text-[10px] leading-none">
										{n.status === "done" ? <CheckIcon className="size-3 shrink-0 text-emerald-500" aria-hidden /> : <span className={cn("size-2 shrink-0 rounded-full", DOT[n.status])} aria-hidden />}
										<span className="font-medium">{STATUS_LABEL[n.status]}</span>
										<span className="ml-auto truncate text-muted-foreground/80" title={n.kind}>
											{n.kind}
										</span>
									</div>
									<div className={cn("line-clamp-2 break-words text-xs leading-4", n.status === "skipped" && "line-through")}>{n.label}</div>
									{dependsOn.has(n.id) && <span className="sr-only">depends on: {dependsOn.get(n.id)!.join(", ")}</span>}
									{onNodeClick && (
										<button
											type="button"
											data-testid="graph-node-hit"
											aria-label={`${n.label} (${STATUS_LABEL[n.status]}${hi ? ", current" : ""})`}
											onClick={() => clickNode(n.id)}
											className="absolute inset-0 cursor-pointer rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
										/>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			</div>
		</div>
	);
}

/**
 * Drag-to-pan state for the draggable view. Pointer events on the box; the pointer is captured only once it travels past
 * CLICK_SLOP, so a plain press still reaches the node button as a click, and a press that became a drag is swallowed
 * (`consumeDrag`). The offset is clamped so the graph cannot leave the box; an axis the graph fits in does not pan.
 */
function usePan(enabled: boolean) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [offset, setOffset] = useState({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const press = useRef<{ x: number; y: number; ox: number; oy: number; id: number } | null>(null);
	const moved = useRef(false);
	const pressSeq = useRef(0);
	const clamp = (v: number, view: number, content: number) => (content <= view ? 0 : Math.min(0, Math.max(view - content, v)));
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
					const box = ref.current;
					const inner = box?.firstElementChild as HTMLElement | null;
					const vw = box?.clientWidth ?? 0;
					const vh = box?.clientHeight ?? 0;
					const cw = inner ? Number.parseFloat(inner.style.width) || 0 : 0;
					const ch = inner ? Number.parseFloat(inner.style.height) || 0 : 0;
					setOffset({ x: clamp(p.ox + dx, vw, cw), y: clamp(p.oy + dy, vh, ch) });
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
	/** The offset clamped to the current layout and box (a refetch or resize can leave the stored one out of view). */
	const view = (cw: number, ch: number) => {
		const box = ref.current;
		if (!box) return offset; // first render: nothing to clamp against yet
		return { x: clamp(offset.x, box.clientWidth ?? 0, cw), y: clamp(offset.y, box.clientHeight ?? 0, ch) };
	};
	return { ref, offset, view, dragging, handlers, consumeDrag };
}
