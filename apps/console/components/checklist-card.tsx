import { cn } from "@/lib/utils";
import { checklistProgress, parseObjectData, type ChecklistData, type ChecklistState } from "@wolfpack/protocol/objects";
import type { ObjectCardProps } from "@/components/card-registry";
import { ObjectCardFrame } from "@/components/object-card";

const ICONS: Record<ChecklistState, string> = { todo: "○", doing: "◐", done: "✓", skipped: "⊘" };

/** The item rows (state icon, label, note) — shared by the inline card and the pinned panel. */
export function ChecklistItems({ items }: { items: ChecklistData["items"] }) {
	return (
		<ul className="flex flex-col gap-1">
			{items.map((i) => (
				<li key={i.id} data-testid="checklist-item" data-state={i.state} className="flex items-start gap-2 text-sm">
					<span aria-hidden className={cn("w-4 shrink-0 text-center", i.state === "done" || i.state === "doing" ? "text-primary" : "text-muted-foreground")}>
						{ICONS[i.state]}
					</span>
					<div className="min-w-0">
						<span className={cn((i.state === "done" || i.state === "skipped") && "text-muted-foreground", i.state === "skipped" && "line-through", i.state === "doing" && "font-medium text-foreground")}>
							{i.label}
						</span>
						<span className="sr-only"> ({i.state})</span>
						{i.note && <div className="text-xs text-muted-foreground">{i.note}</div>}
					</div>
				</li>
			))}
		</ul>
	);
}

/** A checklist object: items with state icons, a done/total bar (skipped items leave the total) and the revision marker. */
export function ChecklistCard({ objectId, rev, data }: ObjectCardProps) {
	const c = parseObjectData("checklist", data);
	if (!c) return null;
	const { done, total, skipped } = checklistProgress(c);
	const summary = total === 0 ? "all skipped" : `${done}/${total} done${skipped > 0 ? ` · ${skipped} skipped` : ""}`;
	const pct = total === 0 ? 0 : (done / total) * 100;
	return (
		<ObjectCardFrame
			testId="checklist-card"
			objectId={objectId}
			rev={rev}
			label="Checklist"
			extra={
				<span data-testid="checklist-progress-text" className="normal-case tracking-normal">
					{summary}
				</span>
			}
		>
			{c.title && <div className="mb-2 text-sm font-medium">{c.title}</div>}
			<div
				role="progressbar"
				aria-label={c.title ?? "Checklist progress"}
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={done}
				aria-valuetext={total === 0 ? "all skipped" : `${done} of ${total} done`}
				data-testid="checklist-progress"
				className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div className="h-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
			</div>
			<ChecklistItems items={c.items} />
		</ObjectCardFrame>
	);
}
