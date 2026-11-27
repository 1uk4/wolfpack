"use client";

/**
 * The dock slot: the empty box the attached thread's own page leaves where its composer used to be (thread-chat.tsx). While it is registered
 * and the page is the attached thread's own, the floating chat bar moves into it (chat-bar.tsx) and is the page's composer, the same
 * component with the same state, not a second one.
 */
import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
const subs = new Set<() => void>();

export function setDockSlot(el: HTMLElement | null): void {
	if (slot === el) return;
	slot = el;
	for (const cb of subs) cb();
}

export function useDockSlot(): HTMLElement | null {
	return useSyncExternalStore(
		(cb) => {
			subs.add(cb);
			return () => void subs.delete(cb);
		},
		() => slot,
		() => null,
	);
}
