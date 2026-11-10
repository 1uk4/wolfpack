import { useSyncExternalStore } from "react";

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
export const dismissKey = (threadId: string, objectId: string) => JSON.stringify([threadId, objectId]);
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
