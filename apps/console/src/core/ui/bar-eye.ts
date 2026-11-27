/**
 * The bar's eye: whether the frame chips the wolf showed in the thread are listed in the bar (open) or tucked behind the eye button (closed,
 * the default). One choice for the whole console, kept per device in localStorage.
 */
import type { KeyValueStore } from "../thread/chat-bar";

export const BAR_EYE_KEY = "wolfpack:bar-eye-open";

export function readEyeOpen(store: Pick<KeyValueStore, "getItem"> | null): boolean {
	try {
		return store?.getItem(BAR_EYE_KEY) === "1";
	} catch {
		return false;
	}
}

export function writeEyeOpen(store: Pick<KeyValueStore, "setItem" | "removeItem"> | null, open: boolean): void {
	try {
		if (open) store?.setItem(BAR_EYE_KEY, "1");
		else store?.removeItem(BAR_EYE_KEY);
	} catch {
		/* storage unavailable: the choice lasts until reload */
	}
	for (const cb of subs) cb();
}

const subs = new Set<() => void>();

/** Calls `cb` whenever the eye changes; returns the unsubscribe. */
export function subscribeEye(cb: () => void): () => void {
	subs.add(cb);
	return () => void subs.delete(cb);
}

/** The device's localStorage, or null on the server or when blocked. */
export function localEyeStore(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}
