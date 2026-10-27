"use client";

/** A work item page body (/kb/work/[id]). Scaffold placeholder; the Work-item task fills it in. */
export function WorkItemPage({ id }: { id: string }) {
	return (
		<div className="p-6 text-sm text-muted-foreground" data-testid="work-item-page" data-work={id}>
			{id}
		</div>
	);
}
