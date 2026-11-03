"use client";

/**
 * THE WORK READER: a work item opened over the current page ("/" the graph, "/work" the list). Entirely URL-driven:
 * `?item=<id>` on the page you are on. Opening pushes that URL (Back closes, Forward re-opens), the page underneath
 * stays mounted so closing returns to it exactly as it was. Neither page knows about the other.
 * Desktop: a right-side panel. Phone (<768px, Tailwind `max-md`): full screen, h-dvh, safe-area padded.
 * Esc closes only the reader (window capture), then the page's own Esc behaviour applies.
 */
import { Suspense, useCallback, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WorkItemPage } from "@/components/work-item-page";

export const ITEM_PARAM = "item";

/** Readers opened in-app since load: while > 0, closing is history.back() (a real Back); else (deep link) it replaces the URL. */
let appOpened = 0;

/** The URL for `path` with the reader on `id` (or closed when null), keeping the page's other params. */
export function readerUrl(path: string, search: string, id: string | null): string {
	const q = new URLSearchParams(search);
	if (id === null) q.delete(ITEM_PARAM);
	else q.set(ITEM_PARAM, id);
	const qs = q.toString();
	return qs ? `${path}?${qs}` : path;
}

export function useWorkReader(): { itemId: string | null; open: (id: string) => void; close: () => void } {
	const router = useRouter();
	const pathname = usePathname() ?? "/";
	const params = useSearchParams();
	const search = params?.toString() ?? "";
	const itemId = params?.get(ITEM_PARAM) || null;
	const open = useCallback(
		(id: string) => {
			if (itemId === null) {
				appOpened++;
				router.push(readerUrl(pathname, search, id), { scroll: false });
			} else router.replace(readerUrl(pathname, search, id), { scroll: false }); // switching item inside the reader: Back still closes it
		},
		[router, pathname, search, itemId],
	);
	const close = useCallback(() => {
		if (appOpened > 0) {
			appOpened--;
			router.back();
		} else router.replace(readerUrl(pathname, search, null), { scroll: false });
	}, [router, pathname, search]);
	return { itemId, open, close };
}

/** Presentational shell (SSR-testable): the panel itself. */
export function WorkReaderPanel({ id, onClose, onOpenTask }: { id: string; onClose: () => void; onOpenTask?: (id: string) => void }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);
	return (
		<div
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
