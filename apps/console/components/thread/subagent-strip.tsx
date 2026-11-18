"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BotIcon, MicIcon, SquareIcon } from "lucide-react";
import { LiveMeter } from "@/components/composer/dictation";
import type { AttachedRow } from "@/components/chat-bar/attached-strip-row";
import { cn } from "@/lib/utils";
import { BrailleSpinner } from "@/components/shell/braille-spinner";
import { useSubagentModal } from "@/components/thread/subagent-modal";
import { useOptionalServerEvent, useOptionalServerResync } from "@/components/shell/server-events";
import { threadBase } from "@/components/thread/thread-transport";
import { formatTokens } from "@/components/thread/usage-format";
import { DONE_LINGER_MS, canStop, elapsedMs, formatChildElapsed, isSettled, partitionChildren, separateTurnMs, stateLabel, threadSlug, upsertChild, type ChildThread } from "@/src/core";

/** A strip row's height, for the composer reserve (see ThreadChat). */
export const STRIP_ROW_PX = 28;

/** The rows the strip draws: active children (settled ones leave at once, they are not listed) plus the attached chat's row. */
function visibleStripRows(items: readonly ChildThread[], now: number, attached?: AttachedRow | null): number {
	return partitionChildren(items, now, false).shown.length + (attached ? 1 : 0);
}

/** The bottom room a thread reserves so its tail scrolls clear of the strip: exactly what the strip draws, 0 for none. */
export function stripReservePx(items: readonly ChildThread[], now: number, attached?: AttachedRow | null): number {
	const rows = visibleStripRows(items, now, attached);
	return rows ? rows * STRIP_ROW_PX + 8 : 0;
}

/**
 * The thread's children, live: fetched on mount, patched by thread-updated, refetched after a reconnect (and on the
 * wolf stream's needs-you baseline, which the server sends on every reconnect of its own stream).
 * A thread-updated that lands while a fetch is in flight is kept and laid over the fetched list (the patch is newer
 * than the snapshot the fetch may have read), so neither a patch nor the fetched siblings are lost.
 */
export function useSubagentChildren(wolf: string, slug: string, threadId: string): ChildThread[] {
	const [children, setChildren] = useState<ChildThread[]>([]);
	const seq = useRef(0);
	const patches = useRef<ChildThread[]>([]);
	const refetch = useCallback(async () => {
		const n = ++seq.current;
		patches.current = []; // events before this fetch started are in what it reads
		try {
			const res = await fetch(`${threadBase(wolf, slug)}/children`);
			if (!res.ok || n !== seq.current) return;
			const body = (await res.json()) as { threads?: ChildThread[] };
			if (!Array.isArray(body.threads) || n !== seq.current) return;
			setChildren(patches.current.reduce<ChildThread[]>(upsertChild, body.threads));
		} catch {
			/* the next event or resync refetches */
		}
	}, [wolf, slug]);
	useEffect(() => {
		void refetch();
	}, [refetch]);
	useOptionalServerEvent("thread-updated", (p) => {
		if (p.wolf !== wolf || p.thread.parentThreadId !== threadId) return;
		patches.current.push(p.thread);
		setChildren((list) => upsertChild(list, p.thread));
	});
	// The wolf stream's baseline (no thread named) means events may have been missed.
	useOptionalServerEvent("needs-you-changed", (p) => {
		if (p.wolf === wolf && p.threadId === undefined) void refetch();
	});
	useOptionalServerResync(() => void refetch());
	return children;
}

/**
 * Re-render once a second while a child's clock runs (running or waiting) or a settled row is still due to fold.
 * `ticking` is computed from the same `now` the rows are drawn with.
 */
function useNow(items: readonly ChildThread[], nowProp?: number): number {
	const [now, setNow] = useState(() => nowProp ?? Date.now());
	const ticking = nowProp === undefined && items.some((c) => c.state === "running" || c.state === "waiting" || (isSettled(c) && !!c.finishedAt && now - Date.parse(c.finishedAt) < DONE_LINGER_MS));
	useEffect(() => {
		if (!ticking) return;
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [ticking]);
	return nowProp ?? now;
}

export function SubagentStripView({
	items,
	now,
	onOpen,
	onStop,
	attached,
}: {
	items: readonly ChildThread[];
	now: number;
	onOpen: (child: ChildThread) => void;
	onStop: (child: ChildThread) => void;
	/** Phone: the floating chat's thread, as one more row (see useAttachedStripRow). */
	attached?: AttachedRow | null;
}) {
	if (visibleStripRows(items, now, attached) === 0) return null;
	const { shown } = partitionChildren(items, now, false);
	return (
		<div data-testid="subagent-strip" className="pointer-events-auto mb-2 overflow-hidden rounded-xl border border-l-2 border-l-(color:--thread-accent) bg-card text-xs shadow-sm">
			{attached && (
				<div data-testid="attached-row" data-state={attached.state} data-listening={attached.listening ? "true" : undefined} className="flex items-center gap-2 px-3 hover:bg-accent" style={{ minHeight: STRIP_ROW_PX }}>
					<button type="button" data-testid="attached-open" aria-label={`Open chat with ${attached.title}`} onClick={attached.onOpen} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left">
						<span data-testid="attached-dot" aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: attached.color }} />
						<span data-testid="attached-title" className="min-w-0 flex-1 truncate font-prose">{attached.title}</span>
						{attached.listening && <MicIcon data-testid="attached-listening" className="size-3 shrink-0 text-red-500" />}
						<span data-testid="attached-state" className="shrink-0 text-muted-foreground">{attached.listening ? "listening" : attached.state === "busy" ? "working" : attached.state === "needs-you" ? "needs you" : "chat"}</span>
					</button>
					{attached.listening && attached.dictation && <LiveMeter dictation={attached.dictation} className="flex h-3 w-16 shrink-0 items-center gap-[2px]" />}
					{attached.listening && attached.onStop && (
						<button type="button" data-testid="attached-stop" aria-label="Stop dictation" onClick={attached.onStop} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-background hover:text-foreground">
							<SquareIcon className="size-3" />
							Stop
						</button>
					)}
				</div>
			)}
			{shown.map((c) => (
				<div key={c.id} data-testid="subagent-row" data-child={c.id} data-state={c.state ?? ""} className="flex items-center gap-2 px-3 hover:bg-accent" style={{ minHeight: STRIP_ROW_PX }}>
					<button type="button" data-testid="subagent-open" onClick={() => onOpen(c)} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left">
						{c.state === "running" ? <BrailleSpinner /> : <BotIcon className="size-3 shrink-0 text-muted-foreground" />}
						<span data-testid="subagent-agent" className="shrink-0 font-medium">{c.agent ?? "agent"}</span>
						<span data-testid="subagent-title" className="min-w-0 flex-1 truncate font-prose">{c.title}</span>
						{c.step && c.state === "running" && <span data-testid="subagent-step" className="max-w-40 truncate text-muted-foreground">{c.step}</span>}
						<span data-testid="subagent-state" className={cn("shrink-0", c.state === "failed" ? "text-destructive" : "text-muted-foreground")}>{stateLabel(c)}</span>
						<ElapsedCell c={c} now={now} />
						<span data-testid="subagent-tokens" className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{c.tokens === undefined ? "—" : formatTokens(c.tokens)}</span>
					</button>
					{canStop(c) && (
						<button type="button" data-testid="subagent-stop" aria-label={`Stop ${c.agent ?? "agent"}`} onClick={() => onStop(c)} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-background hover:text-foreground">
							<SquareIcon className="size-3" />
							Stop
						</button>
					)}
				</div>
			))}
		</div>
	);
}

/**
 * The status strip pinned above the composer: one row per child of this thread. Clicking a row opens the subagent
 * modal over the current page. Stop aborts the child's thread.
 */
export function SubagentStrip({ wolf, slug, items, now: nowProp, attached }: { wolf: string; slug: string; items: readonly ChildThread[]; now?: number; attached?: AttachedRow | null }) {
	const { openSubagent } = useSubagentModal();
	const now = useNow(items, nowProp);
	const open = useCallback((c: ChildThread) => openSubagent(c.id, wolf), [openSubagent, wolf]);
	const [stopError, setStopError] = useState<string | null>(null);
	// A state change (the stop took, or the child moved on) makes the error stale.
	const states = items.map((c) => `${c.id}:${c.state}`).join();
	useEffect(() => setStopError(null), [states]);
	const stop = useCallback(
		async (c: ChildThread) => {
			setStopError(null);
			try {
				const res = await fetch(`${threadBase(wolf, threadSlug(wolf, c.id))}/abort`, { method: "POST" });
				if (!res.ok && res.status !== 404 && res.status !== 409) setStopError(`Could not stop ${c.agent ?? "the agent"} (${res.status}).`);
			} catch {
				setStopError(`Could not stop ${c.agent ?? "the agent"}.`);
			}
		},
		[wolf],
	);
	return (
		<>
			<SubagentStripView items={items} now={now} onOpen={open} onStop={(c) => void stop(c)} attached={attached} />
			{stopError && (
				<div data-testid="subagent-stop-error" className="pointer-events-auto mb-2 text-xs text-destructive">
					{stopError}
				</div>
			)}
		</>
	);
}

/** The strip's time cell: `turn 1m 12s · 14m` after a resume (turn first, the total muted), else the single total as before. */
function ElapsedCell({ c, now }: { c: ChildThread; now: number }) {
	const total = c.startedAt ? formatChildElapsed(elapsedMs(c, now)) : "—";
	const turn = separateTurnMs(c, now);
	if (turn === undefined) return <span data-testid="subagent-elapsed" className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{total}</span>;
	return (
		<span data-testid="subagent-elapsed" title={`turn ${formatChildElapsed(turn)} · total ${total}`} className="w-40 shrink-0 whitespace-nowrap text-right tabular-nums text-muted-foreground">
			<span data-testid="subagent-elapsed-turn">turn {formatChildElapsed(turn)}</span>
			<span data-testid="subagent-elapsed-total" className="opacity-60"> · {total}</span>
		</span>
	);
}
