"use client";

import { WorkItemPage } from "@/components/work/work-item-page";
import type { ViewRendererProps } from "../registry";

/** Kind "work": the work item page in its panel mode. Child tasks push onto the stack, so back returns to the parent. */
export function WorkItemViewRenderer({ descriptor, onPush, onClose }: ViewRendererProps) {
	return <WorkItemPage id={descriptor.id} onClose={onClose} onOpenTask={(id) => onPush({ kind: "work", id })} />;
}
