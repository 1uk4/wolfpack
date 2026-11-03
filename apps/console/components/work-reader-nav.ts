"use client";

/** URL-driven state of the work reader (`?item=<id>`): kept apart from work-reader.tsx so the id chip can open the reader without an import cycle (reader -> item page -> markdown -> chip). */
import { useCallback, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export const ITEM_PARAM = "item";

/** Marker in the history entry's state: this entry was created by opening the reader in-app, so Back leaves the reader and stays on the page. */
const MARK = "wolfpackReader";
const hist = (): { state: unknown; replaceState: (s: unknown, t: string) => void } | null => (typeof window === "undefined" ? null : (window.history as never));
const isMarked = (): boolean => !!(hist()?.state as Record<string, unknown> | null)?.[MARK];
/** Set when this tab opens (or switches) the reader in-app; the next committed URL change stamps it into the history entry. */
let pendingMark = false;

/** The URL for `path` with the reader on `id` (or closed when null), keeping the page's other params. */
export function readerUrl(path: string, search: string, id: string | null): string {
	const q = new URLSearchParams(search);
	if (id === null) q.delete(ITEM_PARAM);
	else q.set(ITEM_PARAM, id);
	const qs = q.toString();
	return qs ? `${path}?${qs}` : path;
}

/** Open the reader on `id` through a router (pushes when closed, replaces when switching items). Also used by the id chip, which may render outside the app router and so cannot call the hook. */
export function openReaderVia(router: { push: (u: string, o?: { scroll?: boolean }) => void; replace: (u: string, o?: { scroll?: boolean }) => void }, pathname: string, search: string, itemId: string | null, id: string): void {
	const url = readerUrl(pathname, search, id);
	if (itemId === null) {
		pendingMark = true;
		router.push(url, { scroll: false });
	} else {
		pendingMark = isMarked(); // switching item inside the reader keeps the entry's in-app mark: Back still closes it
		router.replace(url, { scroll: false });
	}
}

export function useWorkReader(): { itemId: string | null; open: (id: string) => void; close: () => void } {
	const router = useRouter();
	const pathname = usePathname() ?? "/";
	const params = useSearchParams();
	const search = params?.toString() ?? "";
	const itemId = params?.get(ITEM_PARAM) || null;
	// Stamp the entry the router just created (push) or rewrote (replace on a marked entry). Next owns history.state, so
	// the marker is added with replaceState once the navigation has committed.
	useEffect(() => {
		if (!pendingMark || itemId === null) return;
		pendingMark = false;
		const h = hist();
		if (h) h.replaceState({ ...((h.state as object | null) ?? {}), [MARK]: true }, "");
	}, [itemId, search]);
	const open = useCallback((id: string) => openReaderVia(router, pathname, search, itemId, id), [router, pathname, search, itemId]);
	const close = useCallback(() => {
		if (isMarked()) router.back();
		else router.replace(readerUrl(pathname, search, null), { scroll: false });
	}, [router, pathname, search]);
	return { itemId, open, close };
}
