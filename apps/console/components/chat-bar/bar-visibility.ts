"use client";

/**
 * The reasons the floating chat bar is hidden right now besides the page itself (see barHiddenFor in src/core/ui/bar-visibility.ts):
 * a surface that covers the whole window (a frame or the graph shown full screen) registers a reason while it is up and clears it when it goes.
 */
import { useSyncExternalStore } from "react";

let reasons: readonly string[] = [];
const subs = new Set<() => void>();

export function setBarHidden(reason: string, hidden: boolean): void {
	const has = reasons.includes(reason);
	if (hidden === has) return;
	reasons = hidden ? [...reasons, reason] : reasons.filter((r) => r !== reason);
	for (const cb of subs) cb();
}

export function useBarHiddenReasons(): readonly string[] {
	return useSyncExternalStore(
		(cb) => {
			subs.add(cb);
			return () => void subs.delete(cb);
		},
		() => reasons,
		() => reasons,
	);
}
