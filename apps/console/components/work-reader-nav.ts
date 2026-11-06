"use client";

/** URL-driven state of the work reader (`?item=<id>`): kept apart from work-reader.tsx so the id chip can open the reader without an import cycle (reader -> item page -> markdown -> chip). */
import { useCallback, useContext, useEffect } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export const ITEM_PARAM = "item";

/** Marker in the history entry's state: this entry was created by opening the reader in-app, so Back leaves the reader and stays on the page. */
const MARK = "wolfpackReader";
const hist = (): { state: unknown; replaceState: (s: unknown, t: string) => void } | null => (typeof window === "undefined" ? null : (window.history as never));
const isMarked = (): boolean => !!(hist()?.state as Record<string, unknown> | null)?.[MARK];
/** Set when this tab opens (or switches) the reader in-app; the next committed URL change stamps it into the history entry. */
let pendingMark = false;
/** The reader this tab just opened whose URL the router has not committed yet (window.location still lags): a second quick open sees the reader as open and replaces instead of pushing a second entry. Expires, and is dropped once the URL catches up or the reader closes. */
let optimistic: { id: string; at: number } | null = null;
const OPTIMISTIC_MS = 1500;
const optimisticId = (now = Date.now()): string | null => (optimistic && now - optimistic.at < OPTIMISTIC_MS ? optimistic.id : null);
/** Drop any in-flight open (reader closed, or the URL has caught up). */
export const settleReaderOpen = (): void => {
	optimistic = null;
};

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
	const wasOpen = itemId !== null || optimisticId() !== null;
	optimistic = { id, at: Date.now() };
	if (!wasOpen) {
		pendingMark = true;
		router.push(url, { scroll: false });
	} else {
		pendingMark = pendingMark || isMarked(); // switching item inside the reader keeps the entry's in-app mark (or the one still waiting to be stamped): Back still closes it
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
		if (itemId === null || itemId === optimistic?.id) settleReaderOpen(); // the URL has caught up
		if (!pendingMark || itemId === null) return;
		pendingMark = false;
		const h = hist();
		if (h) h.replaceState({ ...((h.state as object | null) ?? {}), [MARK]: true }, "");
	}, [itemId, search]);
	const open = useCallback((id: string) => openReaderVia(router, pathname, search, itemId, id), [router, pathname, search, itemId]);
	const close = useCallback(() => {
		settleReaderOpen();
		if (isMarked()) router.back();
		else router.replace(readerUrl(pathname, search, null), { scroll: false });
	}, [router, pathname, search]);
	return { itemId, open, close };
}

type ReaderRouter = Parameters<typeof openReaderVia>[0];

/** Open work item `id` in the reader ON THE CURRENT PAGE: the one entry point for every link to a work item (chip card, memory panel, subagent task, palette, reader links). Reads the live location, so it needs no Suspense boundary; without a router (outside the app) it falls back to a full load of the same URL. */
export function openWorkItem(router: ReaderRouter | null, id: string): void {
	const { pathname, search } = window.location;
	const params = new URLSearchParams(search);
	if (router) openReaderVia(router, pathname, params.toString(), params.get(ITEM_PARAM) || null, id);
	else window.location.assign(readerUrl(pathname, params.toString(), id));
}

/** `openWork(id)` bound to the app router. */
export function useOpenWorkItem(): (id: string) => void {
	const router = useContext(AppRouterContext);
	return useCallback((id: string) => openWorkItem(router as ReaderRouter | null, id), [router]);
}

/** True for an unmodified primary click nobody else handled: the only click an in-place link may take over (Cmd/Ctrl/Shift/Alt/middle-click keep the real href). */
export function isPlainClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
	return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented;
}

/** onClick for an `<a href="/kb/work/<id>">`: plain clicks open the reader in place; modified clicks keep the link's normal behaviour (new tab, full page). */
export function openReaderLink(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented?: boolean; preventDefault: () => void }, open: ((id: string) => void) | undefined, id: string): void {
	if (!open || !isPlainClick({ ...e, defaultPrevented: e.defaultPrevented ?? false })) return;
	e.preventDefault();
	open(id);
}

/** The work id of a `/kb/work/<id>` href, else null. */
export function workIdOfHref(href: string): string | null {
	if (!href.startsWith("/kb/work/")) return null;
	try {
		return decodeURIComponent(href.slice(9));
	} catch {
		return null;
	}
}

/** onClick for a link whose href may be a work page (`/kb/work/<id>`): opens the reader in place, any other href keeps its normal navigation. */
export function openWorkHrefLink(e: Parameters<typeof openReaderLink>[0], href: string, open: (id: string) => void): void {
	const id = workIdOfHref(href);
	if (id) openReaderLink(e, open, id);
}
