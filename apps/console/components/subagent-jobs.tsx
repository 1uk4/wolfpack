"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BotIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { elapsedMs, formatChildElapsed, isChildThread, isLive, stateLabel, type ChildThread } from "@/src/core";

type Job = ChildThread & { meta?: string };

/**
 * The job panel (sidebar, above Settings): every subagent of every wolf, from wolfd's thread list: live ones first
 * (running, waiting, queued); settled ones are not listed (visibility only, the data stays). Each row opens the child's thread and links the
 * task it serves. Draws nothing while there are no subagents. This is what the legacy activity feed was for wolfd wolves.
 */
export function SubagentJobs<T extends Job>({ rows, onOpen, now: nowProp }: { rows: readonly T[]; onOpen: (job: T) => void; now?: number }) {
	const jobs = rows.filter(isChildThread);
	const live = jobs.filter(isLive);
	const [now, setNow] = useState(() => nowProp ?? Date.now());
	useEffect(() => {
		if (nowProp !== undefined || live.length === 0) return;
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [live.length, nowProp]);
	if (live.length === 0) return null;
	const at = nowProp ?? now;
	const row = (j: T) => (
		<div key={j.id} data-testid="subagent-job" data-state={j.state ?? ""} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-accent">
			{j.state === "running" ? <BrailleSpinner /> : <BotIcon className="size-3 shrink-0 text-muted-foreground" />}
			<button type="button" onClick={() => onOpen(j)} className="flex min-w-0 flex-1 flex-col text-left">
				<span className="truncate font-prose">{j.title}</span>
				<span className="truncate text-muted-foreground">
					{j.meta ? `${j.meta} · ` : ""}
					{j.agent ?? "agent"} · {stateLabel(j)}
					{j.startedAt ? ` · ${formatChildElapsed(elapsedMs(j, at))}` : ""}
				</span>
			</button>
			{j.taskId && (
				<Link href={`/kb/work/${encodeURIComponent(j.taskId)}`} data-testid="subagent-job-task" className="shrink-0 text-muted-foreground underline-offset-2 hover:underline">
					task
				</Link>
			)}
		</div>
	);
	return (
		<section data-testid="subagent-jobs" className="border-t border-border px-3 pb-2 pt-2">
			<div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">
				<BotIcon className="size-3" />
				Subagents
				<span className="ml-auto tabular-nums" data-testid="subagent-jobs-live">{live.length} active</span>
			</div>
			<div className="flex max-h-[30dvh] flex-col overflow-y-auto">
				{live.map(row)}
			</div>
		</section>
	);
}
