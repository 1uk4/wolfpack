"use client";

import { useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";

export interface ThreadCompactionData {
	summary: string;
	at?: string;
	reason?: string;
}

/** The part type the projection gives a wolfd compaction marker (see view.ts, `thread-compaction`). */
export const THREAD_COMPACTION_PART = "data-thread-compaction";

function timeOf(at: string | undefined): string {
	const d = at ? new Date(at) : undefined;
	return d && !Number.isNaN(d.getTime()) ? d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

/** "Context compacted · <time>" divider where wolfd compacted the thread; click expands the summary (markdown, collapsed by default). */
export function ThreadCompactionDivider({ data }: { data: ThreadCompactionData }) {
	const [open, setOpen] = useState(false);
	const time = timeOf(data.at);
	const label = ["Context compacted", time, data.reason && data.reason !== "manual" ? data.reason : ""].filter(Boolean).join(" · ");
	return (
		<div data-testid="thread-compaction" className="my-2 flex w-full flex-col items-center gap-2">
			<div className="flex w-full items-center gap-3">
				<span className="h-0 flex-1 border-t border-dotted border-border/60" aria-hidden />
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
					className="rounded-full border border-border/80 px-2.5 py-0.5 font-ui text-xs text-muted-foreground hover:text-foreground"
				>
					{label} {open ? "▾" : "▸"}
				</button>
				<span className="h-0 flex-1 border-t border-dotted border-border/60" aria-hidden />
			</div>
			{open && (
				<div data-testid="thread-compaction-summary" className="w-full rounded-md border bg-card px-3 py-2 text-sm">
					{data.summary ? <MessageResponse>{data.summary}</MessageResponse> : <span className="text-muted-foreground">No summary text.</span>}
				</div>
			)}
		</div>
	);
}
