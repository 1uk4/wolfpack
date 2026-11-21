"use client";

import { useMemo } from "react";
import { threadColor, threadColorIndex, type ThreadColorInfo, type ThreadColorSource } from "@/src/core";

/** `threadColor(thread, all, wolfColor)` for a view with no list poll (the open thread, the floating bar), memoized on its inputs. */
export function useThreadColor(thread: ThreadColorSource, all: readonly ThreadColorSource[] = [], wolfColor?: string | null): ThreadColorInfo {
	// eslint-disable-next-line react-hooks/exhaustive-deps -- only id/kind/parentThreadId of thread affect the colour; the thread object itself changes every poll
	return useMemo(() => threadColor(thread, threadColorIndex(all), wolfColor), [thread.id, thread.kind, thread.parentThreadId, all, wolfColor]);
}
