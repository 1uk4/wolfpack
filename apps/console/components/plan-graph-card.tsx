import { parseObjectData } from "@wolfpack/protocol/objects";
import type { ObjectCardProps } from "@/components/card-registry";
import { ObjectCardFrame } from "@/components/object-card";
import { usePanelHost } from "@/components/panel-host";
import { PlanGraphView } from "@/components/plan-graph-view";
import { isWorkItemId } from "@/src/core";

/**
 * A plan/task graph object. A node whose id is a work item id opens the Status panel on that task; any other node
 * (a free-form step id the model chose) does nothing.
 */
export function PlanGraphCard({ objectId, rev, data }: ObjectCardProps) {
	const panels = usePanelHost();
	const g = parseObjectData("graph", data);
	if (!g) return null;
	const detailed = g.nodes.filter((n) => n.detail);
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
			<PlanGraphView graph={g} onNodeClick={(id) => void (isWorkItemId(id) && panels.openPanel("memory", { taskId: id, nonce: Date.now() }))} />
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
