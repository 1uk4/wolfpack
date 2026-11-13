"use client";

/**
 * THE WORK READER: a work item opened over the current page ("/" the graph, "/work" the list). Entirely URL-driven:
 * `?item=<id>` on the page you are on. Opening pushes that URL (Back closes, Forward re-opens), the page underneath
 * stays mounted so closing returns to it exactly as it was. Neither page knows about the other.
 * Desktop: a right-side panel. Phone (<768px, Tailwind `max-md`): full screen, h-dvh, safe-area padded.
 * Mounted ONCE, in AppShell (components/shell/sidebar.tsx): `?item=<id>` opens it over whichever page is showing.
 *
 * Esc order, topmost first: (1) anything with role dialog/alertdialog/menu/listbox or aria-modal other than the reader
 * itself (the id hover card, the chat bar's thread switcher, the command palette, the subagent modal, the graduate dialog)
 * owns the key and closes first; the reader stays. (2) An Esc another layer already claimed (defaultPrevented) is left alone.
 * (3) Otherwise the reader closes, including with focus in the chat bar composer or a bar card (neither handles Esc).
 */
import { Suspense, useEffect, useRef } from "react";
import { WorkItemPage } from "@/components/work/work-item-page";

export { ITEM_PARAM, readerUrl, useWorkReader } from "@/components/work/work-reader-nav";
import { useWorkReader } from "@/components/work/work-reader-nav";

const OVERLAY = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-modal="true"]';
/** An overlay that is really up: connected and not hidden by an attribute or inline style (a persistent closed list must not swallow Esc forever). */
function shown(el: Element): boolean {
	if (!el.isConnected || el.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
	for (let n: Element | null = el; n; n = n.parentElement) {
		const st = (n as HTMLElement).style;
		if (st?.display === "none" || st?.visibility === "hidden") return false;
	}
	return true;
}

/** Presentational shell (SSR-testable): the panel itself. */
export function WorkReaderPanel({ id, onClose, onOpenTask }: { id: string; onClose: () => void; onOpenTask?: (id: string) => void }) {
	const panelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			// A dialog above the reader (the graduate dialog from the visible list, a popover) owns this Esc.
			const own = panelRef.current;
			for (const d of Array.from(document.querySelectorAll(OVERLAY))) if (d !== own && shown(d)) return;
			e.preventDefault();
			e.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);
	// Take focus on open (the close button, else the panel) so Tab and Esc work in the reader at once.
	// On close, give focus back to whatever had it (like overlay-shell); a detached opener (palette, modal) is skipped.
	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null;
		const own = panelRef.current;
		(own?.querySelector<HTMLElement>('[data-testid="work-reader-close"]') ?? own)?.focus();
		return () => {
			if (opener?.isConnected) opener.focus?.();
		};
	}, []); // once per open; switching items in place keeps focus where the user put it
	return (
		<div
			ref={panelRef}
			tabIndex={-1}
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

/** Mount once, in AppShell: the reader for every page. */
export function WorkReaderHost() {
	return (
		<Suspense fallback={null}>
			<Host />
		</Suspense>
	);
}
