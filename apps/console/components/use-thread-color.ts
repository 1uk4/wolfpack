"use client";

import { useMemo, useSyncExternalStore } from "react";
import { knownColor, onThreadColor, threadColor, threadColorIndex, threadColorVersion, type ThreadColorInfo, type ThreadColorSource } from "@/src/core";

/**
 * The live `threadColor(thread, all)` for a view with no list poll (the open thread, the floating bar): the data it was
 * given at load, with every pick announced on the shared store since (this thread's or its parent's) laid over it.
 */
export function useThreadColor(thread: ThreadColorSource, all: readonly ThreadColorSource[] = []): ThreadColorInfo {
	const tick = useSyncExternalStore((cb) => onThreadColor(() => cb()), threadColorVersion, threadColorVersion);
	return useMemo(() => {
		void tick;
		const lay = (t: ThreadColorSource): ThreadColorSource => {
			const k = knownColor(t.id);
			if (!k) return t;
			const { settings: _s, color: _c, ...rest } = t;
			return k.color ? { ...rest, color: k.color } : rest;
		};
		return threadColor(lay(thread), threadColorIndex(all.map(lay)));
	}, [tick, thread.id, thread.parentThreadId, thread.color, thread.settings, all]);
}
