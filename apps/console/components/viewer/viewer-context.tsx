"use client";

/**
 * Thread-page viewer triggers. `ViewerProvider` (mounted by the thread page only) makes `useOpenView()` return a function
 * that opens a view in that thread's viewer; off the thread page there is no provider and it returns null, so chips and
 * links keep their normal navigation.
 */
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { openView } from "./viewer-store";
import type { ViewDescriptor } from "./view-descriptor";

type OpenViewFn = (d: ViewDescriptor) => void;
const ViewerContext = createContext<OpenViewFn | null>(null);

export function ViewerProvider({ wolf, threadId, children }: { wolf: string; threadId: string; children: ReactNode }) {
	const open = useCallback((d: ViewDescriptor) => openView(wolf, threadId, d), [wolf, threadId]);
	return <ViewerContext.Provider value={open}>{children}</ViewerContext.Provider>;
}

/** The open function, or null when not on a thread page. */
export function useOpenView(): OpenViewFn | null {
	return useContext(ViewerContext);
}

/** An in-app KB link: `/kb/entry/<id>` is kind kb, `/kb/work/<id>` is kind work; anything else is null. */
export function viewFromHref(href: string | null): { kind: "kb" | "work"; id: string } | null {
	const m = /^\/kb\/(entry|work)\/([^/?#]+)$/.exec(href ?? "");
	if (!m) return null;
	try {
		return { kind: m[1] === "entry" ? "kb" : "work", id: decodeURIComponent(m[2]!) };
	} catch {
		return null;
	}
}
