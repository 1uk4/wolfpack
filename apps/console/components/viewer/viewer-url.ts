"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { parseViewKey, viewKey } from "./view-descriptor";
import { getViewerState, setViewerState, useViewer, type ViewerState } from "./viewer-store";

/** The thread URL's `?view=` param: the viewKey of the top descriptor while the viewer is open. */
export const VIEW_PARAM = "view";

/** Query string (no leading `?`) with `view` set to `topKey`, or removed when null; every other param is kept. */
export function nextSearch(current: string, topKey: string | null): string {
	const p = new URLSearchParams(current);
	if (topKey) p.set(VIEW_PARAM, topKey);
	else p.delete(VIEW_PARAM);
	return p.toString();
}

/**
 * Load-time merge: a parsable `?view=` wins and is pushed on top of the saved stack (no duplicate when the saved top is
 * the same) and the viewer opens. Returns null when there is nothing to merge (no param, or it does not parse).
 */
export function mergeOnLoad(saved: ViewerState, param: string | null): ViewerState | null {
	const d = param ? parseViewKey(param) : null;
	if (!d) return null;
	const top = saved.stack[saved.stack.length - 1];
	return { stack: top && viewKey(top) === viewKey(d) ? saved.stack : [...saved.stack, d], open: true };
}

/**
 * Keeps `?view=` in step with the thread's viewer store. Once on mount the URL is merged into the store; afterwards every
 * stack/open change is written back with router.replace (never push, so browser Back leaves the thread).
 */
export function useViewerUrlSync(wolf: string, threadId: string) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const { stack, open } = useViewer(wolf, threadId);
	const search = searchParams?.toString() ?? "";
	const skip = useRef(false);

	useEffect(() => {
		const merged = mergeOnLoad(getViewerState(wolf, threadId), new URLSearchParams(search).get(VIEW_PARAM));
		if (!merged) return;
		skip.current = true; // the store update re-runs the sync below with the merged state
		setViewerState(wolf, threadId, merged);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- on mount (per thread) only
	}, [wolf, threadId]);

	const top = stack[stack.length - 1];
	const topKey = open && top ? viewKey(top) : null;
	useEffect(() => {
		if (skip.current) {
			skip.current = false;
			return;
		}
		if (new URLSearchParams(search).get(VIEW_PARAM) === topKey) return;
		const qs = nextSearch(search, topKey);
		router.replace(qs ? `${pathname}?${qs}` : pathname);
	}, [topKey, search, pathname, router]);
}
