"use client";

/**
 * THE WORK READER: a work item opened over the current page ("/" the graph, "/work" the list). Entirely URL-driven:
 * `?item=<id>` on the page you are on. Opening pushes that URL (Back closes, Forward re-opens), the page underneath
 * stays mounted so closing returns to it exactly as it was. Neither page knows about the other.
 * Desktop: a right-side panel. Phone (<768px, Tailwind `max-md`): full screen, h-dvh, safe-area padded.
 * Esc closes only the reader (window capture), unless a dialog is open above it; then the page's own Esc behaviour applies.
 */
import { Suspense, useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WorkItemPage } from "@/components/work-item-page";

export { ITEM_PARAM, readerUrl, useWorkReader } from "@/components/work-reader-nav";
import { ITEM_PARAM, readerUrl, useWorkReader } from "@/components/work-reader-nav";

/** Presentational shell (SSR-testable): the panel itself. */
export function WorkReaderPanel({ id, onClose, onOpenTask }: { id: string; onClose: () => void; onOpenTask?: (id: string) => void }) {
	const panelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			// A dialog above the reader (the graduate dialog from the visible list, a popover) owns this Esc.
			const own = panelRef.current;
			for (const d of Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"]'))) if (d !== own) return;
			e.preventDefault();
			e.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);
	return (
		<div
			ref={panelRef}
			role="dialog"
			aria-label="Work item reader"
			data-testid="work-reader"
			data-work={id}
			className="fixed inset-y-0 right-0 z-[60] flex w-[min(52rem,70vw)] flex-col border-l bg-background max-md:inset-0 max-md:h-dvh max-md:w-full max-md:border-l-0 max-md:pb-[env(safe-area-inset-bottom)] max-md:pt-[env(safe-area-inset-top)]"
		>
			<WorkItemPage id={id} onClose={onClose} onOpenTask={onOpenTask} />
		</div>
	);
}

function Host() {
	const { itemId, open, close } = useWorkReader();
	if (!itemId) return null;
	return <WorkReaderPanel id={itemId} onClose={close} onOpenTask={open} />;
}

/** Mount once per page that can open work items. */
export function WorkReaderHost() {
	return (
		<Suspense fallback={null}>
			<Host />
		</Suspense>
	);
}
