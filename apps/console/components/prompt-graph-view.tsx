"use client";

/**
 * One Prompts graph drawn with the Work/plan graph component (PlanGraphView): a layered left-to-right DAG you pan by dragging.
 * Only the node look is ours: title, host marker, editable / read-only marker. Layout, edges and panning are the shared ones.
 */
import { useMemo } from "react";
import type { GraphData } from "@wolfpack/protocol/objects";
import { cn } from "@/lib/utils";
import { PlanGraphView } from "@/components/plan-graph-view";
import { dependencyEdges, HOST_LABEL, type GraphNodeDef, type PromptGraph } from "../src/core/prompt-flows.ts";

const MARKER_CLASS: Record<GraphNodeDef["marker"], string> = {
	editable: "text-emerald-600 dark:text-emerald-400",
	"partly editable": "text-emerald-600 dark:text-emerald-400",
	"read-only": "text-muted-foreground",
	"no prompt": "text-muted-foreground/70",
};

export function PromptGraphCanvas({ graph, selected, onSelect }: { graph: PromptGraph; selected: string | null; onSelect: (id: string) => void }) {
	const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n] as const)), [graph]);
	const data: GraphData = useMemo(
		() => ({
			nodes: graph.nodes.map((n) => ({ id: n.id, label: n.title, kind: HOST_LABEL[n.host], status: "todo" as const })),
			edges: dependencyEdges(graph.edges),
		}),
		[graph],
	);
	return (
		<PlanGraphView
			key={`${graph.key}:${graph.nodes.length}`}
			graph={data}
			label={`${graph.title} prompt graph`}
			draggable
			recenterOnResize
			fill
			highlightId={selected}
			onNodeClick={onSelect}
			nodeSize={{ width: 176, height: 68 }}
			renderNode={(gn) => {
				const n = byId.get(gn.id)!;
				return {
					name: `${n.title} (${HOST_LABEL[n.host]}, ${n.marker}${n.hubMissing ? ", hub not connected" : ""})`,
					className: cn("border-border bg-card text-foreground", n.host === "hub" && "border-sky-400/70", n.host === "wolfd-pi-durable" && "border-violet-400/70"),
					body: (
						<>
							<div className="flex items-center gap-1.5 text-[10px] leading-none" data-testid={`pnode-${n.id}`}>
								<span className="truncate font-medium">{HOST_LABEL[n.host]}</span>
								<span className={cn("ml-auto shrink-0", MARKER_CLASS[n.marker])}>{n.hubMissing ? "hub not connected" : n.marker}</span>
							</div>
							<div className="line-clamp-2 break-words text-xs leading-4">{n.title}</div>
							{n.sub && <div className="truncate text-[10px] leading-none text-muted-foreground">{n.sub}</div>}
						</>
					),
				};
			}}
		/>
	);
}
