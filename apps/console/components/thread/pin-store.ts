import { useSyncExternalStore } from "react";
import { viewKey, type ViewDescriptor } from "../viewer/view-descriptor";

/**
 * Shared state of the pinned panels (progress, checklist, decision, graph): which cards the user dismissed (persisted)
 * and which panel is open (session). Neutral module so every pin kind imports the same store.
 */

/**
 * Dismissed list, persisted in localStorage. The storage key and the checklist's `[threadId, objectId]` entries predate
 * the other kinds; keep them so stored dismissals still work. New kinds namespace the objectId (`decision:<id>`).
 */
const DISMISSED_KEY = "wp.pinned-checklist.dismissed.v1";
const DISMISSED_MAX = 200;
/**
 * `pinRev` is the agent's pin count for the object (0/absent: it never pinned explicitly). A dismissal is made at the pinRev
 * then shown, so a later agent pin or unpin (higher pinRev) is a different key and shows the object again, while a plain
 * revision (same pinRev) stays dismissed.
 */
export const dismissKey = (threadId: string, objectId: string, pinRev?: number) => JSON.stringify(pinRev ? [threadId, objectId, pinRev] : [threadId, objectId]);
/** The dismissal key of an active pinned object; `id` overrides the objectId part (decisions and graphs namespace it by kind). */
export const activeDismissKey = (threadId: string, a: { objectId: string; pinRev: number }, id: string = a.objectId) => dismissKey(threadId, id, a.pinRev);
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

export function dismiss(key: string) {
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

/** Whether `key` (see dismissKey) was dismissed. SSR-safe: the server snapshot is "not dismissed", the client reads localStorage after hydration. */
export function useDismissed(key: string | undefined): boolean {
	return useSyncExternalStore(
		subscribeDismissed,
		() => key !== undefined && isDismissed(key),
		() => false,
	);
}

// ---------------------------------------------------------------- open panel (session only: survives remounts, not a reload)

/**
 * One open panel per thread across the whole pinned column: the feature progress panel, the checklist and every decision or
 * graph pin. Opening one collapses the rest. Ids: `progress`, `checklist`, `decision:<objectId>`, `graph:<objectId>`.
 */
export const PANEL_PROGRESS = "progress";
export const PANEL_CHECKLIST = "checklist";
const openPanels = new Map<string, string>();
const panelListeners = new Set<() => void>();

/** Open `id` (replacing whichever panel was open) or, with null, collapse whatever is open. */
export function setOpenPanel(threadId: string, id: string | null) {
	if ((openPanels.get(threadId) ?? null) === id) return;
	if (id === null) openPanels.delete(threadId);
	else openPanels.set(threadId, id);
	for (const l of panelListeners) l();
}

/** Collapse `id` only if it is the open one (a closing panel must not collapse a different one that just opened). */
export function closePanel(threadId: string, id: string) {
	if (openPanels.get(threadId) === id) setOpenPanel(threadId, null);
}

export const togglePanel = (threadId: string, id: string) => (openPanels.get(threadId) === id ? closePanel(threadId, id) : setOpenPanel(threadId, id));

function subscribePanels(l: () => void) {
	panelListeners.add(l);
	return () => void panelListeners.delete(l);
}

/** The id of the thread's open panel, or null. */
export function useOpenPanel(threadId: string): string | null {
	return useSyncExternalStore(subscribePanels, () => openPanels.get(threadId) ?? null, () => null);
}

/** Test hook: forget which panels are open. */
export function resetOpenPanels() {
	openPanels.clear();
}

// ---------------------------------------------------------------- pinned views (viewer)

/**
 * Views pinned from the viewer header: any number per thread (not the newest-of-type rule of objects), in pin order, persisted
 * in localStorage as `{ [threadId]: ViewDescriptor[] }`. Independent of the dismissed list above.
 */
const VIEWS_KEY = "wp.pinned-views.v1";
const VIEWS_MAX_PER_THREAD = 50;
const EMPTY_VIEWS: readonly ViewDescriptor[] = [];
let viewsCache: Record<string, ViewDescriptor[]> | null = null;
const viewListeners = new Set<() => void>();

function readViews(): Record<string, ViewDescriptor[]> {
	if (viewsCache) return viewsCache;
	const out: Record<string, ViewDescriptor[]> = {};
	try {
		const v: unknown = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "{}");
		if (v && typeof v === "object" && !Array.isArray(v)) {
			for (const [tid, list] of Object.entries(v as Record<string, unknown>)) {
				if (!Array.isArray(list)) continue;
				const ds = list
					.filter((d): d is ViewDescriptor => !!d && typeof (d as ViewDescriptor).kind === "string" && typeof (d as ViewDescriptor).id === "string")
					.map((d) => (typeof d.title === "string" ? { kind: d.kind, id: d.id, title: d.title } : { kind: d.kind, id: d.id }));
				if (ds.length) out[tid] = ds;
			}
		}
	} catch {
		/* unreadable: start empty */
	}
	viewsCache = out;
	return out;
}

function writeViews(next: Record<string, ViewDescriptor[]>) {
	viewsCache = next;
	try {
		if (Object.keys(next).length === 0) localStorage.removeItem(VIEWS_KEY);
		else localStorage.setItem(VIEWS_KEY, JSON.stringify(next));
	} catch {
		/* memory only */
	}
	for (const l of viewListeners) l();
}

/** The thread's pinned views in pin order. The array identity is stable until the list changes. */
export function getPinnedViews(threadId: string): readonly ViewDescriptor[] {
	return readViews()[threadId] ?? EMPTY_VIEWS;
}

export const isViewPinned = (threadId: string, d: Pick<ViewDescriptor, "kind" | "id">): boolean => getPinnedViews(threadId).some((p) => viewKey(p) === viewKey(d));

/** Pin `d` with its title (the chip shows it). Re-pinning keeps the place and refreshes a given title. */
export function pinView(threadId: string, d: ViewDescriptor) {
	const cur = getPinnedViews(threadId);
	const entry: ViewDescriptor = d.title ? { kind: d.kind, id: d.id, title: d.title } : { kind: d.kind, id: d.id };
	const list = isViewPinned(threadId, d)
		? cur.map((p) => (viewKey(p) === viewKey(d) ? { ...entry, ...(entry.title || !p.title ? {} : { title: p.title }) } : p))
		: [...cur, entry].slice(-VIEWS_MAX_PER_THREAD);
	writeViews({ ...readViews(), [threadId]: list });
}

export function unpinView(threadId: string, d: Pick<ViewDescriptor, "kind" | "id">) {
	if (!isViewPinned(threadId, d)) return;
	const { [threadId]: cur = [], ...rest } = readViews();
	const list = cur.filter((p) => viewKey(p) !== viewKey(d));
	writeViews(list.length ? { ...rest, [threadId]: list } : rest);
}

function subscribeViews(l: () => void) {
	viewListeners.add(l);
	const onStorage = (e: StorageEvent) => {
		if (e.key !== null && e.key !== VIEWS_KEY) return;
		viewsCache = null;
		for (const x of viewListeners) x();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		viewListeners.delete(l);
		window.removeEventListener("storage", onStorage);
	};
}

export function usePinnedViews(threadId: string): readonly ViewDescriptor[] {
	return useSyncExternalStore(subscribeViews, () => getPinnedViews(threadId), () => EMPTY_VIEWS);
}

/** Test hook: forget the in-memory pinned views (storage stays). */
export function resetPinnedViewsCache() {
	viewsCache = null;
}
