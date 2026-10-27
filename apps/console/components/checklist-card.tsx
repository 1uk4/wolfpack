import { cn } from "@/lib/utils";
import { checklistProgress, parseObjectData, type ChecklistState } from "@wolfpack/protocol/objects";
import type { ObjectCardProps } from "@/components/card-registry";
import { updatedMarker } from "@/components/decision-card";

const ICONS: Record<ChecklistState, string> = { todo: "○", doing: "◐", done: "✓", skipped: "⊘" };

/** A checklist object: items with state icons, a done/total bar (derived here, never sent) and the revision marker. */
export function ChecklistCard({ objectId, rev, data }: ObjectCardProps) {
	const c = parseObjectData("checklist", data);
	if (!c) return null;
	const { done, total } = checklistProgress(c);
	const marker = updatedMarker(rev);
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="checklist-card" data-object-id={objectId} data-rev={rev}>
			<div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<span>Checklist</span>
				<span data-testid="checklist-progress-text" className="normal-case tracking-normal">
					{done}/{total}
				</span>
				{marker && (
					<span data-testid="object-updated" className="rounded-full border px-2 py-0.5 normal-case tracking-normal">
						{marker}
					</span>
				)}
			</div>
			{c.title && <div className="mb-2 text-sm font-medium">{c.title}</div>}
			<div
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={done}
				data-testid="checklist-progress"
				className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div className="h-full bg-primary transition-[width]" style={{ width: `${(done / total) * 100}%` }} />
			</div>
			<ul className="flex flex-col gap-1">
				{c.items.map((i) => (
					<li key={i.id} data-testid="checklist-item" data-state={i.state} className="flex items-start gap-2 text-sm">
						<span aria-hidden className={cn("w-4 shrink-0 text-center", i.state === "done" && "text-primary", i.state === "doing" && "text-primary", i.state !== "done" && i.state !== "doing" && "text-muted-foreground")}>
							{ICONS[i.state]}
						</span>
						<div className={cn("min-w-0", (i.state === "done" || i.state === "skipped") && "text-muted-foreground", i.state === "skipped" && "line-through")}>
							<span className={cn(i.state === "doing" && "font-medium text-foreground")}>{i.label}</span>
							{i.note && <div className="text-xs text-muted-foreground no-underline">{i.note}</div>}
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
