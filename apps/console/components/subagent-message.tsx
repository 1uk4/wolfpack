"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useSubagentModal } from "@/components/subagent-modal";
import { SPEAKER } from "@/components/speaker-colors";
import { cn } from "@/lib/utils";
import { EVENT_LABEL, resolveChild, type SubagentOrigin } from "@/src/core/subagent-message";
import type { ChildThread } from "@/src/core/subagents";

const ACCENT: Record<SubagentOrigin["event"], string> = {
	result: SPEAKER.child.bar,
	question: SPEAKER.child.bar,
	merge: SPEAKER.child.bar,
	warning: "border-l-amber-500/70 bg-amber-500/5",
	error: "border-l-destructive/70 bg-destructive/5",
};
const LABEL: Record<SubagentOrigin["event"], string> = {
	result: SPEAKER.child.text,
	question: SPEAKER.child.text,
	merge: SPEAKER.child.text,
	warning: "text-amber-600 dark:text-amber-400",
	error: "text-destructive",
};

/** A sub-agent's delivery to this thread: its own accent and title, collapsed to one line, the title opens the child's modal. */
export function SubagentMessage({ origin, children, wolf }: { origin: SubagentOrigin; children: readonly ChildThread[]; wolf: string }) {
	const [open, setOpen] = useState(false);
	const { openSubagent } = useSubagentModal();
	const child = resolveChild(origin, children);
	const agent = child?.agent ?? "sub-agent";
	const title = origin.name ? `${agent} · ${origin.name}` : agent;
	const status = origin.duration ? `${EVENT_LABEL[origin.event]} in ${origin.duration}` : EVENT_LABEL[origin.event];
	return (
		<div data-testid="subagent-message" data-event={origin.event} data-open={open} className={cn("my-2 w-full border-l-[3px] bg-card py-1 pl-3 pr-4 font-ui text-xs", ACCENT[origin.event])}>
			<div className="flex items-center gap-2">
				<button type="button" data-testid="subagent-message-toggle" aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen((v) => !v)} className="flex shrink-0 items-center text-muted-foreground">
					<ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
				</button>
				{child ? (
					<button type="button" data-testid="subagent-message-title" onClick={() => openSubagent(child.id, wolf)} className="font-medium uppercase tracking-wide hover:underline">
						{title}
					</button>
				) : (
					<span data-testid="subagent-message-title" className="font-medium uppercase tracking-wide">{title}</span>
				)}
				<span data-testid="subagent-message-status" className={cn("shrink-0", LABEL[origin.event])}>{status}</span>
				{!open && <span data-testid="subagent-message-summary" className="min-w-0 flex-1 truncate font-prose text-muted-foreground">{origin.summary}</span>}
			</div>
			{open && (
				<div data-testid="subagent-message-body" className="lh-prose mt-1 text-foreground">
					<MessageResponse>{origin.body}</MessageResponse>
				</div>
			)}
		</div>
	);
}
