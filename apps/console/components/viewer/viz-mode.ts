import { useCallback, useSyncExternalStore } from "react";

/**
 * Visualization mode of a thread page: the transcript and the page composer hide, the Viewer takes the full width and the
 * floating chat bar shows over it. Two small stores:
 *  - the owner's choice, per thread, in localStorage under `wolfpack:viz:<threadId>` (thread ids already start with the wolf name) ("1" when on, key removed when off);
 *  - which thread page is IN the mode right now (set by that page), which the chat bar reads to show itself on that page.
 */
export const vizKey = (wolf: string, threadId: string) => (threadId.startsWith(`${wolf}/`) ? `wolfpack:viz:${threadId}` : `wolfpack:viz:${wolf}:${threadId}`);

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
	listeners.add(cb);
	return () => void listeners.delete(cb);
};
const emit = () => listeners.forEach((l) => l());

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : (window.localStorage ?? null);
	} catch {
		return null;
	}
}

export function getVizMode(wolf: string, threadId: string): boolean {
	try {
		// The key used to be `wolfpack:viz:<wolf>:<threadId>`; drop the stale one (value not migrated).
		if (threadId.startsWith(`${wolf}/`)) storage()?.removeItem(`wolfpack:viz:${wolf}:${threadId}`);
		return storage()?.getItem(vizKey(wolf, threadId)) === "1";
	} catch {
		return false;
	}
}

export function setVizMode(wolf: string, threadId: string, on: boolean): void {
	try {
		if (on) storage()?.setItem(vizKey(wolf, threadId), "1");
		else storage()?.removeItem(vizKey(wolf, threadId));
	} catch {
		/* best effort */
	}
	emit();
}

/** The stored choice for a thread and its setter. The server snapshot is off. */
export function useVizMode(wolf: string, threadId: string): [boolean, (on: boolean) => void] {
	const on = useSyncExternalStore(subscribe, () => getVizMode(wolf, threadId), () => false);
	return [on, useCallback((v: boolean) => setVizMode(wolf, threadId, v), [wolf, threadId])];
}

export interface VizActive {
	wolf: string;
	threadId: string;
}
let active: VizActive | null = null;

/** Published by the thread page while it is in the mode (null when it leaves or unmounts). */
export function setVizActive(next: VizActive | null): void {
	if (active?.wolf === next?.wolf && active?.threadId === next?.threadId) return;
	active = next;
	emit();
}
export const getVizActive = () => active;
export function useVizActive(): VizActive | null {
	return useSyncExternalStore(subscribe, () => active, () => null);
}
