"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { getLatestShownView, subscribe as subscribeViewer } from "@/components/viewer/viewer-store";
import { PRESENCE_TTL_MS, createPresenceController, targetFromPath, targetFromView, type PresenceTarget } from "./owner-presence";

/** Fire and forget. fetch (not sendBeacon): the hub sign-in wrapper on window.fetch adds the bearer, a beacon cannot. The route always answers 204. */
function publish(t: PresenceTarget): void {
	try {
		void fetch("/api/activity/presence", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...t, ttlMs: PRESENCE_TTL_MS }),
			keepalive: true,
		}).catch(() => {});
	} catch {
		/* never throws */
	}
}

/**
 * useOwnerPresence: reports the owner's current thread, work item or KB entry to the hub (the live map's "you" node).
 * The viewer panel's open view wins over the page's own target; it is forgotten on every route change. Mounted once (OwnerPresence, root layout).
 */
export function useOwnerPresence(): void {
	const pathname = usePathname();
	const ctl = useRef<ReturnType<typeof createPresenceController> | null>(null);
	const pageTarget = useRef<PresenceTarget | null>(null);
	const viewTarget = useRef<PresenceTarget | null>(null);

	useEffect(() => {
		const c = createPresenceController({ send: publish });
		ctl.current = c;
		const activeNow = () => document.visibilityState === "visible" && document.hasFocus();
		const onActive = () => c.setActive(activeNow());
		c.setActive(activeNow());
		document.addEventListener("visibilitychange", onActive);
		window.addEventListener("focus", onActive);
		window.addEventListener("blur", onActive);
		const unsub = subscribeViewer(() => {
			viewTarget.current = targetFromView(getLatestShownView());
			c.setTarget(viewTarget.current ?? pageTarget.current);
		});
		return () => {
			unsub();
			document.removeEventListener("visibilitychange", onActive);
			window.removeEventListener("focus", onActive);
			window.removeEventListener("blur", onActive);
			c.dispose();
			ctl.current = null;
		};
	}, []);

	useEffect(() => {
		viewTarget.current = null; // a panel view belongs to the page it was opened on
		pageTarget.current = targetFromPath(pathname ?? "");
		ctl.current?.setTarget(pageTarget.current);
	}, [pathname]);
}

export function OwnerPresence() {
	useOwnerPresence();
	return null;
}
