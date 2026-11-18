"use client";

import { useId, type KeyboardEvent } from "react";
import { DecisionCard } from "@/components/thread/decision-card";
import { PlanGraphCard } from "@/components/thread/plan-graph-card";
import { activeDismissKey, closePanel, dismiss, togglePanel, useOpenPanel } from "@/components/thread/pin-store";
import { sessionFindHasForegroundLayer } from "@/components/thread/session-find";
import type { ActiveObject } from "@/src/core";

/** Height of one collapsed pin row incl. gap (rem), for the transcript's top reserve. */
export const PINNED_OBJECT_ROW_REM = 2.75;

const LABEL = { decision: "Decision", graph: "Graph" } as const;

/** Dismissal and expansion are keyed by kind + objectId, so a decision and a checklist sharing an objectId never collide. */
const pinId = (a: ActiveObject) => `${a.type}:${a.objectId}`;
/** The persisted dismissal key of a pinned decision/graph (checklists keep their plain `[threadId, objectId]` key). */
export const pinnedObjectDismissKey = (threadId: string, a: ActiveObject | undefined) => (a ? activeDismissKey(threadId, a, pinId(a)) : undefined);

/**
 * One pinned decision or graph: a collapsed row "Decision · title" (toggle) with a dismiss ×; expanded it shows the same
 * card as the transcript. A revision of the same objectId updates it in place; dismissal is per thread + kind + objectId.
 * Only one panel in the pinned column is open at a time (pin-store); Esc collapses it.
 */
export function PinnedObject({ active, threadId, onDismiss }: { active: ActiveObject; threadId: string; onDismiss?: () => void }) {
	const key = pinId(active);
	const open = useOpenPanel(threadId) === key;
	const panelId = useId();
	const title = active.data.title;
	const Card = active.type === "decision" ? DecisionCard : PlanGraphCard;
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || !open || sessionFindHasForegroundLayer(document)) return;
		e.stopPropagation(); // claim the Esc (one-Esc law, like the checklist)
		closePanel(threadId, key);
	};
	return (
		<div
			onKeyDown={onKeyDown}
			className="pointer-events-auto relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg"
			data-testid={`pinned-${active.type}`}
			data-object-id={active.objectId}
			data-rev={active.rev}
			data-expanded={open}
		>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onClick={() => togglePanel(threadId, key)}
				data-testid="pinned-object-button"
				className="flex h-9 w-full shrink-0 items-center gap-2 pl-3 pr-9 text-left text-sm hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
			>
				<span className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{LABEL[active.type]}</span>
				<span className="min-w-0 flex-1 truncate font-medium" data-testid="pinned-object-title">{title ?? LABEL[active.type]}</span>
				<span aria-hidden className={`shrink-0 text-xs text-muted-foreground ${open ? "rotate-180" : ""}`}>▾</span>
			</button>
			<button
				type="button"
				aria-label={`Dismiss ${active.type}`}
				title={`Dismiss ${active.type}`}
				data-testid="pinned-object-close"
				onClick={() => {
					closePanel(threadId, key);
					dismiss(activeDismissKey(threadId, active, key));
					onDismiss?.();
				}}
				className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
			>
				<span aria-hidden>×</span>
			</button>
			{open && (
				// Capped by the column (flex shrink against the space the panels above leave), with dvh as the upper bound.
				<div id={panelId} role="region" aria-label={title ?? LABEL[active.type]} className="max-h-[50dvh] min-h-0 overflow-y-auto overscroll-contain border-t p-2" data-testid="pinned-object-panel">
					<Card objectId={active.objectId} type={active.type} rev={active.rev} data={active.data} />
				</div>
			)}
		</div>
	);
}

/**
 * The stack of pinned decision/graph rows. It is the last child of the pinned column (checklist / feature progress above
 * it, in normal flow), so it always sits below whichever panel is open, at that panel's real height.
 */
export function PinnedObjects({ items, threadId, onDismiss }: { items: ActiveObject[]; threadId: string; onDismiss?: () => void }) {
	if (items.length === 0) return null;
	return (
		<div className="pointer-events-none flex min-h-0 flex-col" data-testid="pinned-objects">
			<div className="mx-auto flex min-h-0 w-full max-w-[46rem] flex-col gap-1 px-4 pt-1">
				{items.map((a) => (
					<PinnedObject key={pinId(a)} active={a} threadId={threadId} onDismiss={onDismiss} />
				))}
			</div>
		</div>
	);
}
