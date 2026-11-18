"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/** In-app route changes since load: > 0 means history.back() stays inside the console. */
let navs = 0;
export const hasInAppHistory = (): boolean => navs > 0;

/** Mounted once in the root layout; counts REAL pathname changes (compared against the previous one), never mounts or strict-mode re-runs. */
export function NavTracker() {
	const pathname = usePathname();
	const last = useRef(pathname);
	useEffect(() => {
		if (last.current !== pathname) {
			last.current = pathname;
			navs++;
		}
	}, [pathname]);
	return null;
}
