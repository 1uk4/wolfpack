"use client";

import { useEffect } from "react";
import { MOBILE_QUERY, keyboardShellHeight, keyboardShellTop, shellBottomInset, shouldResetPageScroll, standaloneViewportShort, trackTallestViewport } from "@/src/core";

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
		// One hidden probe reads env(safe-area-inset-top) (no JS API for it)
		const probe = document.createElement("div");
		probe.setAttribute("aria-hidden", "true");
		probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top)";
		document.body.appendChild(probe);
		const standalone = () => (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
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
			// home-screen app whose viewport already ends above the home indicator: the bottom inset would only waste space
			const short = h === null && standaloneViewportShort({ standalone: standalone(), keyboardOpen: false, innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenWidth: window.screen.width, screenHeight: window.screen.height, insetTop: parseFloat(getComputedStyle(probe).paddingTop) || 0 });
			const nextInset = inset === "0px" || short ? "0px" : "";
			if (nextInset !== lastInset) nextInset ? root.style.setProperty("--wp-safe-bottom", nextInset) : root.style.removeProperty("--wp-safe-bottom");
			lastInset = nextInset;
			// iOS also scrolls the document when the focused field opens the keyboard; the shell is fixed, so that only pushes the header under the status bar
			if (shouldResetPageScroll(h !== null, window.scrollY)) window.scrollTo(0, 0);
		};
		apply();
		vv?.addEventListener("resize", apply);
		vv?.addEventListener("scroll", apply);
		window.addEventListener("scroll", apply, { passive: true });
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
			window.removeEventListener("scroll", apply);
			probe.remove();
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
