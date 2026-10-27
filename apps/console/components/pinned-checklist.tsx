"use client";

import { useCallback, useId, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { checklistProgress } from "@wolfpack/protocol/objects";
import { ChecklistItems } from "@/components/checklist-card";
import { sessionFindHasForegroundLayer } from "@/components/session-find";
import type { ActiveChecklist } from "@/src/core";

/** Expanded state per thread, for the session (module scope: survives remounts, not a reload). Default collapsed. */
const expandedThreads = new Set<string>();

/**
 * Visibility rule (owner): the pinned status goes away in exactly two cases, and never on its own (not when every item
 * is done, not on a timeout, not on a thread switch, reload, reconnect or stream reset):
 *  (a) the agent sends a checklist with a DIFFERENT objectId: it replaces this one (activeChecklist, objects.ts: the
 *      objectId upserted last wins; if the agent later revises the OLD objectId again, that is the agent sending that
 *      checklist again, so it becomes the pinned one);
 *  (b) the user dismisses it with the close button. A dismissal is keyed by thread + objectId and persisted in
 *      localStorage, so it survives reload, a new session and reconnect. Revisions of the SAME objectId stay
 *      dismissed; a checklist with a different objectId pins again.
 */
const DISMISSED_KEY = "wp.pinned-checklist.dismissed.v1";
const DISMISSED_MAX = 200;
const dismissKey = (threadId: string, objectId: string) => JSON.stringify([threadId, objectId]);
/** Fallback when localStorage is unavailable (private mode, quota): dismissal then lasts for the page's lifetime. Capped like the stored list. */
let memoryDismissed: string[] = [];
const dismissListeners = new Set<() => void>();
/** Parsed stored list, so getSnapshot never parses JSON per render; invalidated on dismiss and on a cross-tab storage event. */
let cache: string[] | null = null;

function readDismissed(fresh = false): string[] {
	if (cache && !fresh) return cache;
	try {
		const v: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
		cache = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		cache = [];
	}
	return cache;
}

function isDismissed(key: string): boolean {
	return memoryDismissed.includes(key) || readDismissed().includes(key);
}

function notify() {
	for (const l of dismissListeners) l();
}

function dismiss(key: string) {
	memoryDismissed = [...memoryDismissed.filter((k) => k !== key), key].slice(-DISMISSED_MAX);
	try {
		// Re-read fresh storage first: another tab may have dismissed something since this tab's cache was filled.
		const next = [...readDismissed(true).filter((k) => k !== key), key].slice(-DISMISSED_MAX);
		localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
		cache = next;
	} catch {
		cache = null; /* memory fallback above */
	}
	notify();
}

function subscribeDismissed(l: () => void) {
	dismissListeners.add(l);
	const onStorage = (e: StorageEvent) => {
		if (e.key !== null && e.key !== DISMISSED_KEY) return;
		cache = null;
		notify();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		dismissListeners.delete(l);
		window.removeEventListener("storage", onStorage);
	};
}

/** Test hook: forget the module-scope caches (the stub storage was reset). */
export function resetDismissedCache() {
	cache = null;
	memoryDismissed = [];
}

/** Whether the user dismissed this thread's checklist `objectId`. SSR-safe: the server snapshot is "not dismissed", the client reads localStorage after hydration. */
export function useChecklistDismissed(threadId: string, objectId: string | undefined): boolean {
	return useSyncExternalStore(
		subscribeDismissed,
		() => objectId !== undefined && isDismissed(dismissKey(threadId, objectId)),
		() => false,
	);
}

/**
 * Top padding the transcript reserves while the card is pinned, so the first message is never under it. Sized for the
 * collapsed card with its "doing" subtitle (about 5.5rem incl. the top gap); the expanded card is a deliberate overlay.
 */
export const PINNED_CHECKLIST_RESERVE = "pt-24";

/**
 * Floating card at the top of the conversation (overlay, like the composer dock at the bottom) for the thread's
 * active checklist (see activeChecklist: the one upserted last; a finished one stays, with ✓, until a newer one
 * appears or the user dismisses it).
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
export function PinnedChecklist({ active, threadId, onDismiss }: { active: ActiveChecklist | undefined; threadId: string; onDismiss?: () => void }) {
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
	const dismissed = useChecklistDismissed(threadId, active?.objectId);
	if (!active || dismissed) return null;
	const { data } = active;
	const { done, total } = checklistProgress(data);
	const finished = total === 0 || done === total;
	const count = total === 0 ? "all skipped" : `${done}/${total}`;
	const pct = total === 0 ? 0 : (done / total) * 100;
	const showBar = done > 0; // nothing done yet: no empty bar (and no gap); the doing subtitle carries the activity
	const doing = data.items.find((i) => i.state === "doing");
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || !open || sessionFindHasForegroundLayer(document)) return;
		e.stopPropagation(); // claim the Esc: the dismiss chain must not also stop dictation / abort the turn
		set(false);
	};
	const close = () => {
		expandedThreads.delete(threadId);
		dismiss(dismissKey(threadId, active.objectId));
		onDismiss?.(); // the focused × is about to unmount: hand focus on (the composer)
	};
	return (
		<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex max-h-full flex-col" data-testid="pinned-checklist" data-object-id={active.objectId} data-expanded={open}>
			<div className="mx-auto flex min-h-0 w-full max-w-[46rem] flex-col px-4 pt-2">
				<div onKeyDown={onKeyDown} className="pointer-events-auto relative flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg">
					<button
						type="button"
						aria-expanded={open}
						aria-controls={open ? panelId : undefined}
						onClick={() => set(!open)}
						data-testid="pinned-checklist-button"
						className={`flex w-full flex-col gap-0.5 pl-3 pr-9 pt-2 ${showBar ? "" : "pb-2"} text-left text-sm hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring`}
					>
						<span className="flex min-w-0 items-center gap-2">
							<span className="min-w-0 flex-1 truncate font-medium" data-testid="pinned-checklist-summary">
								{finished && total > 0 && <span aria-hidden>✓ </span>}
								{data.title ?? "Checklist"} · {count}
							</span>
							<span aria-hidden className={`shrink-0 text-xs text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}>
								▾
							</span>
						</span>
						{doing && (
							<span data-testid="pinned-checklist-doing" className="min-w-0 truncate text-xs text-muted-foreground">
								◐ {doing.label}
							</span>
						)}
					</button>
					<button
						type="button"
						aria-label="Dismiss checklist"
						title="Dismiss checklist"
						onClick={close}
						data-testid="pinned-checklist-close"
						className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
					>
						<span aria-hidden>×</span>
					</button>
					{showBar && (
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
					)}
					{open && (
						<div id={panelId} role="region" aria-label={data.title ?? "Checklist"} data-testid="pinned-checklist-panel" className="min-h-0 overflow-y-auto overscroll-contain border-t p-3">
							<ChecklistItems items={data.items} />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
