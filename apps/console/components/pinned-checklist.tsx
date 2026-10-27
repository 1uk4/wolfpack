"use client";

import { useCallback, useId, useState, type KeyboardEvent } from "react";
import { checklistProgress } from "@wolfpack/protocol/objects";
import { ChecklistItems } from "@/components/checklist-card";
import { sessionFindHasForegroundLayer } from "@/components/session-find";
import type { ActiveChecklist } from "@/src/core";

/** Expanded state per thread, for the session (module scope: survives remounts, not a reload). Default collapsed. */
const expandedThreads = new Set<string>();

/**
 * Top padding the transcript reserves while the card is pinned, so the first message is never under it. Sized for the
 * collapsed card with its "doing" subtitle (about 5.5rem incl. the top gap); the expanded card is a deliberate overlay.
 */
export const PINNED_CHECKLIST_RESERVE = "pt-24";

/**
 * Floating card at the top of the conversation (overlay, like the composer dock at the bottom) for the thread's
 * active checklist (see activeChecklist: the one upserted last; a finished one stays, with ✓, until a newer one
 * appears).
 *
 * Collapsed by default: "Title · done/total", a progress loader that fills with done/total (pulsing while an item
 * is "doing") and the doing item as a subtitle. The title row is the toggle button; the loader is a sibling of it
 * (a button's children are presentational, so a progressbar inside would not be exposed). Clicking expands the card
 * in place to the full list (the same ChecklistItems as the inline card); click again collapses.
 *
 * Esc collapses only when it is pressed from inside the card and no menu/dialog is up (one-Esc law); Esc in the
 * composer, or with a popover open, is left to its owner. Live revisions and the history seed both arrive through
 * `active`, so the card refreshes in either state.
 */
export function PinnedChecklist({ active, threadId }: { active: ActiveChecklist | undefined; threadId: string }) {
	const [open, setOpen] = useState(() => expandedThreads.has(threadId));
	const panelId = useId();
	const set = useCallback(
		(v: boolean) => {
			if (v) expandedThreads.add(threadId);
			else expandedThreads.delete(threadId);
			setOpen(v);
		},
		[threadId],
	);
	if (!active) return null;
	const expanded = open;
	const { data } = active;
	const { done, total } = checklistProgress(data);
	const finished = total === 0 || done === total;
	const count = total === 0 ? "all skipped" : `${done}/${total}`;
	const pct = total === 0 ? 0 : (done / total) * 100;
	const doing = data.items.find((i) => i.state === "doing");
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || !expanded || sessionFindHasForegroundLayer(document)) return;
		e.stopPropagation(); // claim the Esc: the dismiss chain must not also stop dictation / abort the turn
		set(false);
	};
	return (
		<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex max-h-full flex-col" data-testid="pinned-checklist" data-object-id={active.objectId} data-expanded={expanded}>
			<div className="mx-auto flex min-h-0 w-full max-w-[46rem] flex-col px-4 pt-2">
				<div onKeyDown={onKeyDown} className="pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg">
					<button
						type="button"
						aria-expanded={expanded}
						aria-controls={expanded ? panelId : undefined}
						onClick={() => set(!expanded)}
						data-testid="pinned-checklist-button"
						className="flex w-full flex-col gap-0.5 px-3 pt-2 text-left text-sm hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
					>
						<span className="flex min-w-0 items-center gap-2">
							<span className="min-w-0 flex-1 truncate font-medium" data-testid="pinned-checklist-summary">
								{finished && total > 0 && <span aria-hidden>✓ </span>}
								{data.title ?? "Checklist"} · {count}
							</span>
							<span aria-hidden className={`shrink-0 text-xs text-muted-foreground transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}>
								▾
							</span>
						</span>
						{doing && (
							<span data-testid="pinned-checklist-doing" className="min-w-0 truncate text-xs text-muted-foreground">
								◐ {doing.label}
							</span>
						)}
					</button>
					<div className="px-3 pb-2 pt-1.5">
						<div
							{...(total > 0
								? { role: "progressbar", "aria-label": data.title ?? "Checklist progress", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": done, "aria-valuetext": `${done} of ${total} done` }
								: { "aria-hidden": true })}
							data-testid="pinned-checklist-loader"
							data-active={doing ? "true" : undefined}
							className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
						>
							<div className="h-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
							{doing && <div aria-hidden className="absolute inset-y-0 right-0 animate-pulse bg-primary/30 motion-reduce:animate-none" style={{ left: `${pct}%` }} />}
						</div>
					</div>
					{expanded && (
						<div id={panelId} role="region" aria-label={data.title ?? "Checklist"} data-testid="pinned-checklist-panel" className="min-h-0 overflow-y-auto overscroll-contain border-t p-3">
							<ChecklistItems items={data.items} />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
