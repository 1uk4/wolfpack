/**
 * Phone layout rules (browser-safe, pure). Below MOBILE_BREAKPOINT the console shows ONE column: the sidebar (Work list / thread
 * list / Graph / Pipeline links) is a full-screen "list" layer; opening anything closes it and shows the content with a back control
 * that re-opens the list. Desktop (>= 768px) never reads any of this.
 */

/** Tailwind's `md`: the same number the CSS (`md:` variants and the @media block in globals.css) uses. */
export const MOBILE_BREAKPOINT = 768;

/** matchMedia query that is true on a phone-sized viewport. */
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

export const isMobileWidth = (width: number): boolean => width < MOBILE_BREAKPOINT;

/** Should the list layer (sidebar) be open after the route changed? A phone navigates list -> content, so any real navigation
 *  closes the list; the first render and same-path updates leave it alone. Desktop: never touched. */
export function listOpenAfterNavigation(mobile: boolean, open: boolean, prevPath: string | null, path: string): boolean {
	if (!mobile) return open;
	return prevPath !== null && prevPath !== path ? false : open;
}

/** Initial list state: a phone starts on the list only at "/" (the app's home); a deep link or reload on a thread/wolf page shows that
 *  content, and back returns to the list. Desktop uses the persisted preference. */
export function initialListOpen(mobile: boolean, stored: string | null, path = "/"): boolean {
	return mobile ? path === "/" : stored === null ? true : stored === "1";
}

/** Height of the visible area above the on-screen keyboard (visualViewport), px; falls back to the layout height. */
export function visibleHeight(vv: { height: number; offsetTop?: number } | null | undefined, innerHeight: number): number {
	const h = vv?.height ?? innerHeight;
	return Math.max(0, Math.round(h));
}

/** Label for the control that returns to the list on a phone. */
export const MOBILE_BACK_LABEL = "Back to list";
