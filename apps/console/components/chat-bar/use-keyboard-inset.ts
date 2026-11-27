"use client";

import { useEffect, useState } from "react";

/** Phone keyboard: how far the visual viewport's bottom sits above the layout viewport's bottom (iOS does not resize the layout, so a fixed dock would stay under the keyboard). 0 when the layout itself resizes (Android, interactive-widget=resizes-content). */
export function useKeyboardInset(enabled: boolean): number {
	const [inset, setInset] = useState(0);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!enabled || !vv) return setInset(0);
		const apply = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
		apply();
		vv.addEventListener("resize", apply);
		vv.addEventListener("scroll", apply);
		return () => {
			vv.removeEventListener("resize", apply);
			vv.removeEventListener("scroll", apply);
		};
	}, [enabled]);
	return inset;
}
