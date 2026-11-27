"use client";

import { useEffect, useState } from "react";
import { BotIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrailleSpinner } from "@/components/shell/braille-spinner";
import { useSubagentModal } from "@/components/thread/subagent-modal";
import { useSubagentChildren } from "@/components/thread/use-subagent-children";
import { elapsedMs, formatChildElapsed, partitionChildren, stateLabel, type ChildThread } from "@/src/core";

/** How long a finished sub-agent keeps its (static) badge in the bar. */
const BADGE_LINGER_MS = 30_000;

/** One badge per sub-agent: name, a moving indicator while it runs (static otherwise) and its elapsed time. Everything else lives in the opened panel. */
export function SubagentBadgesView({ items, now, onOpen }: { items: readonly ChildThread[]; now: number; onOpen: (child: ChildThread) => void }) {
	const { shown } = partitionChildren(items, now, false, BADGE_LINGER_MS);
	return (
		<>
			{shown.map((c) => {
				const name = c.title || c.agent || "agent";
				return (
				<button
					key={c.id}
					type="button"
					data-testid="subagent-badge"
					data-state={c.state ?? ""}
					aria-label={`${name}, ${stateLabel(c)}`}
					title={name}
					onClick={() => onOpen(c)}
					className="flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 font-ui text-xs text-muted-foreground hover:bg-accent max-md:min-h-11"
				>
					{c.state === "running" ? <BrailleSpinner /> : <BotIcon className={cn("size-3 shrink-0", c.state === "failed" && "text-destructive")} />}
					<span className="max-w-28 truncate font-medium text-foreground">{name}</span>
					<span data-testid="subagent-badge-elapsed" className="tabular-nums">{c.startedAt ? formatChildElapsed(elapsedMs(c, now)) : "—"}</span>
				</button>
				);
			})}
		</>
	);
}

/** The bar's sub-agent badges for the attached thread; the elapsed time ticks each second while any is live. */
export function SubagentBadges({ wolf, slug, threadId }: { wolf: string; slug: string; threadId: string }) {
	const items = useSubagentChildren(wolf, slug, threadId);
	const { openSubagent } = useSubagentModal();
	const [now, setNow] = useState(() => Date.now());
	const live = items.some((c) => c.state === "running" || c.state === "waiting" || !!c.finishedAt);
	useEffect(() => {
		if (!live) return;
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [live]);
	return <SubagentBadgesView items={items} now={now} onOpen={(c) => openSubagent(c.id, wolf)} />;
}
