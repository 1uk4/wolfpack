"use client";

/**
 * One Prompts graph drawn with the Work/plan graph component (PlanGraphView): a layered left-to-right DAG you pan by dragging.
 * Only the node look is ours: title, host marker, editable / read-only marker. Layout, edges and panning are the shared ones.
 */
import { useMemo } from "react";
import { LockIcon, PencilIcon } from "lucide-react";
import type { GraphData } from "@wolfpack/protocol/objects";
import { cn } from "@/lib/utils";
import { PlanGraphView } from "@/components/plan-graph-view";
import { dependencyEdges, HOST_LABEL, type GraphNodeDef, type PromptGraph } from "../../src/core/settings/prompt-flows.ts";

/** The marker as an icon (the words stay in the node's aria-label): a pen when it can be edited, a lock when read-only, nothing for a step with no prompt. */
export function MarkerIcon({ marker, className }: { marker: GraphNodeDef["marker"]; className?: string }) {
	if (marker === "editable" || marker === "partly editable") return <PencilIcon className={cn("size-3 text-emerald-600 dark:text-emerald-400", className)} aria-label={marker} role="img" />;
	if (marker === "read-only") return <LockIcon className={cn("size-3 text-muted-foreground", className)} aria-label={marker} role="img" />;
	return null;
}

export function PromptGraphCanvas({ graph, selected, onSelect }: { graph: PromptGraph; selected: string | null; onSelect: (id: string) => void }) {
	const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n] as const)), [graph]);
	const data: GraphData = useMemo(
		() => ({
			nodes: graph.nodes.map((n) => ({ id: n.id, label: n.title, kind: HOST_LABEL[n.host], status: "todo" as const })),
			edges: dependencyEdges(graph.edges),
		}),
		[graph],
	);
	// The Tools graph has 17+ leaves: one-line nodes and rows level with their group, so it fits the box at a readable scale.
	const compact = graph.key === "tools";
	return (
		<PlanGraphView
			key={`${graph.key}:${graph.nodes.length}`}
			graph={data}
			label={`${graph.title} prompt graph`}
			draggable
			zoomable
			fill
			toolbarAbove
			alignToDependents={compact}
			highlightId={selected}
			onNodeClick={onSelect}
			nodeSize={{ width: 176, height: compact ? 26 : 68 }}
			renderNode={(gn) => {
				const n = byId.get(gn.id)!;
				return {
					name: `${n.title} (${n.host === "wolf" ? "" : `${HOST_LABEL[n.host]}, `}${n.marker}${n.hubMissing ? ", hub not connected" : ""})`,
					className: cn("border-border bg-card text-foreground", n.host === "hub" && "border-sky-400/70", n.host === "wolfd-pi-durable" && "border-violet-400/70"),
					body: compact ? (
						<div className="flex items-center gap-1.5 text-xs leading-none" data-testid={`pnode-${n.id}`}>
							<span className="min-w-0 flex-1 truncate">{n.title}</span>
							<MarkerIcon marker={n.marker} />
						</div>
					) : (
						<>
							{(n.host !== "wolf" || n.hubMissing || n.marker !== "no prompt") && (
								<div className="flex items-center gap-1.5 text-[10px] leading-none" data-testid={`pnode-${n.id}`}>
									{n.host !== "wolf" && <span className="truncate font-medium">{HOST_LABEL[n.host]}</span>}
									<span className="ml-auto flex shrink-0 items-center gap-1">
										{n.hubMissing && <span className="text-muted-foreground">hub not connected</span>}
										<MarkerIcon marker={n.marker} />
									</span>
								</div>
							)}
							<div className="line-clamp-2 break-words text-xs leading-4">{n.title}</div>
							{n.sub && <div className="truncate text-[10px] leading-none text-muted-foreground">{n.sub}</div>}
						</>
					),
				};
			}}
		/>
	);
}
