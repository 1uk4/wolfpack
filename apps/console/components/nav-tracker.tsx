"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** In-app route changes since load: > 0 means history.back() stays inside the console. */
let navs = 0;
export const hasInAppHistory = (): boolean => navs > 0;

/** Mounted once in the root layout; counts pathname changes after the first render. */
export function NavTracker() {
	const pathname = usePathname();
	useEffect(() => {
		return () => {
			navs++;
		};
	}, [pathname]);
	return null;
}
