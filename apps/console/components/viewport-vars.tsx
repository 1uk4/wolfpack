"use client";

import { useEffect } from "react";
import { MOBILE_QUERY, keyboardShellHeight, keyboardShellTop, shellBottomInset, trackTallestViewport } from "@/src/core";

/** Publishes --wp-vvh (the visible height above the on-screen keyboard) on <html>, phones only. iOS Safari does not shrink the layout
 *  viewport when the keyboard opens, so `dvh` alone leaves the composer under it; globals.css sizes the thread to this var. */
export function ViewportVars() {
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(MOBILE_QUERY);
		const vv = window.visualViewport;
		const root = document.documentElement;
		let last = "";
		let lastTop = "";
		let lastInset = "";
		let tallest: { width: number; height: number } | null = null;
		const apply = () => {
			if (!mq.matches) {
				tallest = null;
				last = "";
				lastTop = "";
				lastInset = "";
				root.style.removeProperty("--wp-vvt");
				root.style.removeProperty("--wp-safe-bottom");
				return void root.style.removeProperty("--wp-vvh");
			}
			// the tallest height seen at this width: standalone iOS shrinks innerHeight with the keyboard too, so the gap alone misses it
			tallest = trackTallestViewport(tallest, window.innerWidth, window.innerHeight);
			const tall = tallest.height;
			const h = keyboardShellHeight(vv, window.innerHeight, tall);
			const next = h === null ? "" : `${h}px`; // no keyboard: no var, the shell is 100dvh (a stale vv.height left a dead band under the composer)
			if (next !== last) next ? root.style.setProperty("--wp-vvh", next) : root.style.removeProperty("--wp-vvh"); // skip no-op writes
			last = next;
			// iOS pans the visual viewport under the keyboard; the fixed shell follows it (top = offsetTop) so the composer stays on screen
			const top = vv ? keyboardShellTop(vv, window.innerHeight, tall) : 0;
			const nextTop = top > 0 ? `${top}px` : "";
			if (nextTop !== lastTop) nextTop ? root.style.setProperty("--wp-vvt", nextTop) : root.style.removeProperty("--wp-vvt");
			lastTop = nextTop;
			// keyboard open: no home-indicator padding under the composer (css falls back to env(...) when the var is unset)
			const inset = shellBottomInset(vv, window.innerHeight, tall);
			const nextInset = inset === "0px" ? inset : "";
			if (nextInset !== lastInset) nextInset ? root.style.setProperty("--wp-safe-bottom", nextInset) : root.style.removeProperty("--wp-safe-bottom");
			lastInset = nextInset;
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
			root.style.removeProperty("--wp-vvt");
			root.style.removeProperty("--wp-safe-bottom");
		};
	}, []);
	return null;
}
