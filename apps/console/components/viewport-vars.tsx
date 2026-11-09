"use client";

import { useEffect } from "react";
import { MOBILE_QUERY, keyboardShellHeight } from "@/src/core";

/** Publishes --wp-vvh (the visible height above the on-screen keyboard) on <html>, phones only. iOS Safari does not shrink the layout
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
				return void root.style.removeProperty("--wp-vvh");
			}
			const h = keyboardShellHeight(vv, window.innerHeight);
			const next = h === null ? "" : `${h}px`; // no keyboard: no var, the shell is 100dvh (a stale vv.height left a dead band under the composer)
			if (next !== last) next ? root.style.setProperty("--wp-vvh", next) : root.style.removeProperty("--wp-vvh"); // skip no-op writes
			last = next;
			if (vv && vv.offsetTop > 0) window.scrollTo(0, 0); // iOS pans the page under the keyboard; the shell is fixed-height
		};
		apply();
		vv?.addEventListener("resize", apply);
		vv?.addEventListener("scroll", apply);
		mq.addEventListener("change", apply);
		// Rotation changes innerHeight without a visualViewport event on some iOS versions, and it settles a frame late.
		let raf = 0;
		const applyNextFrame = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(apply);
		};
		window.addEventListener("resize", applyNextFrame);
		window.addEventListener("orientationchange", applyNextFrame);
		return () => {
			vv?.removeEventListener("resize", apply);
			vv?.removeEventListener("scroll", apply);
			mq.removeEventListener("change", apply);
			window.removeEventListener("resize", applyNextFrame);
			window.removeEventListener("orientationchange", applyNextFrame);
			cancelAnimationFrame(raf);
			root.style.removeProperty("--wp-vvh");
		};
	}, []);
	return null;
}
