import { useId } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseObjectData, type GraphNodeStatus } from "@wolfpack/protocol/objects";
import type { ObjectCardProps } from "@/components/card-registry";
import { ObjectCardFrame } from "@/components/object-card";
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

/** A plan/task graph object: a layered DAG (prerequisites left, dependents right), status-coloured; scrolls sideways when wide. */
export function PlanGraphCard({ objectId, rev, data }: ObjectCardProps) {
	const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const g = parseObjectData("graph", data);
	if (!g) return null;
	const layout = layoutGraph(g.nodes, g.edges);
	const labelOf = new Map(g.nodes.map((n) => [n.id, n.label] as const));
	const dependsOn = new Map<string, string[]>();
	for (const e of g.edges) (dependsOn.get(e.from) ?? dependsOn.set(e.from, []).get(e.from)!).push(labelOf.get(e.to)!);
	const detailed = g.nodes.filter((n) => n.detail);
	const at = new Map(layout.nodes.map((p) => [p.id, p] as const));
	const done = g.nodes.filter((n) => n.status === "done").length;
	return (
		<ObjectCardFrame
			testId="plan-graph-card"
			objectId={objectId}
			rev={rev}
			label="Graph"
			extra={
				<span className="normal-case tracking-normal" data-testid="graph-progress">
					{done}/{g.nodes.length} done
				</span>
			}
		>
			{g.title && <div className="mb-2 text-sm font-medium">{g.title}</div>}
			<div className="overflow-x-auto pb-1" data-testid="graph-scroll">
				<div className="relative" role="group" aria-label={`Plan graph${g.title ? `: ${g.title}` : ""}, ${g.nodes.length} nodes, ${done} done`} style={{ width: layout.width, height: layout.height }}>
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
					{g.nodes.map((n) => {
						const p = at.get(n.id)!;
						return (
							<li
								key={n.id}
								data-testid="graph-node"
								data-node-id={n.id}
								data-status={n.status}
								data-kind={n.kind}
								data-rank={p.rank}
								title={n.detail ? `${n.label} — ${n.detail}` : n.label}
								className={cn("absolute flex flex-col gap-1 overflow-hidden rounded-lg border px-2.5 py-1.5", CARD[n.status])}
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
							</li>
						);
					})}
					</ul>
				</div>
			</div>
			{detailed.length > 0 && (
				<details className="mt-2 text-xs" data-testid="graph-details">
					<summary className="cursor-pointer text-muted-foreground">Details</summary>
					<ul role="list" className="mt-1 flex list-none flex-col gap-1 p-0">
						{detailed.map((n) => (
							<li key={n.id}>
								<span className="font-medium">{n.label}</span>: {n.detail}
							</li>
						))}
					</ul>
				</details>
			)}
		</ObjectCardFrame>
	);
}
