"use client";

import { useEffect } from "react";
import { MOBILE_QUERY, visibleHeight } from "@/src/core";

/** Publishes --lh-vvh (the visible height above the on-screen keyboard) on <html>, phones only. iOS Safari does not shrink the layout
 *  viewport when the keyboard opens, so `dvh` alone leaves the composer under it; globals.css sizes the thread to this var. */
export function ViewportVars() {
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(MOBILE_QUERY);
		const vv = window.visualViewport;
		const root = document.documentElement;
		let last = "";
		const apply = () => {
			if (!mq.matches) {
				last = "";
				return void root.style.removeProperty("--lh-vvh");
			}
			const next = `${visibleHeight(vv, window.innerHeight)}px`;
			if (next !== last) root.style.setProperty("--lh-vvh", next); // skip no-op writes (scroll events fire often)
			last = next;
			if (vv && vv.offsetTop > 0) window.scrollTo(0, 0); // iOS pans the page under the keyboard; the shell is fixed-height
		};
		apply();
		vv?.addEventListener("resize", apply);
		vv?.addEventListener("scroll", apply);
		mq.addEventListener("change", apply);
		return () => {
			vv?.removeEventListener("resize", apply);
			vv?.removeEventListener("scroll", apply);
			mq.removeEventListener("change", apply);
			root.style.removeProperty("--lh-vvh");
		};
	}, []);
	return null;
}
