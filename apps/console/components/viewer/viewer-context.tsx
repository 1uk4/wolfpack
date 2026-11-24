"use client";

/**
 * Viewer triggers. `ViewerProvider` (the thread page, or a PageViewer) makes `useOpenView()` return a function that opens
 * a view in that host's viewer; with no provider it returns null, so chips and links keep their normal navigation. The
 * function returns false (and does nothing) for a kind the host does not allow, and `canOpen(kind)` asks first: a
 * trigger that cannot open the kind falls back to its normal navigation.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { hostAllows, hostStoreArgs, threadHost, type ViewerHost } from "./viewer-host";
import { openView } from "./viewer-store";
import { isPlainClick } from "@/components/work/work-reader-nav";
import type { ViewDescriptor } from "./view-descriptor";

export type OpenViewFn = ((d: ViewDescriptor) => boolean) & { canOpen: (kind: string) => boolean };
const ViewerContext = createContext<OpenViewFn | null>(null);

export function ViewerProvider({ wolf, threadId, host, children }: { wolf?: string; threadId?: string; host?: ViewerHost; children: ReactNode }) {
	const h = host ?? threadHost(wolf ?? "", threadId ?? "");
	const kinds = h.allowedKinds === "all" ? "all" : h.allowedKinds.join(",");
	const open = useMemo<OpenViewFn>(() => {
		const [a, b] = hostStoreArgs(h);
		const fn = ((d: ViewDescriptor) => {
			if (!hostAllows(h, d.kind)) return false;
			openView(a, b, d);
			return true;
		}) as OpenViewFn;
		fn.canOpen = (kind) => hostAllows(h, kind);
		return fn;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- h is rebuilt each render; id + kinds are its value
	}, [h.id, kinds]);
	return <ViewerContext.Provider value={open}>{children}</ViewerContext.Provider>;
}

/** The open function, or null outside a viewer host. */
export function useOpenView(): OpenViewFn | null {
	return useContext(ViewerContext);
}

/** onClick for a link to a KB entry or work page: a plain click opens it in the viewer (when the host allows the kind); modified clicks and hosts without a viewer keep the real href. */
export function openKbLink(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented?: boolean; preventDefault: () => void }, open: OpenViewFn | null, kind: "kb" | "work", id: string): void {
	if (!open || !open.canOpen(kind) || !isPlainClick({ ...e, defaultPrevented: e.defaultPrevented ?? false })) return;
	e.preventDefault();
	open({ kind, id });
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
