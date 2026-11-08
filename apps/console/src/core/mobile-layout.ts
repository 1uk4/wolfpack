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

/** Open state after the user SELECTS something in the list (a row, a nav link, New session). A phone navigates list -> content, so a
 *  selection closes the list; this is called from the click handlers themselves, not inferred from a pathname change (a tap on the
 *  route you are already on changes no path and must still reveal the content). Desktop: never touched. */
export function listOpenAfterSelect(mobile: boolean, open: boolean): boolean {
	return mobile ? false : open;
}

/** The stored desktop preference ("1"/"0"/null), as an open flag. */
export const storedListOpen = (stored: string | null): boolean => (stored === null ? true : stored === "1");

/** Initial list state: a phone starts on the list only at "/" (the app's home); a deep link or reload on a thread/wolf page shows that
 *  content, and back returns to the list. Desktop uses the persisted preference. */
export function initialListOpen(mobile: boolean, stored: string | null, path = "/"): boolean {
	return mobile ? path === "/" : storedListOpen(stored);
}

/** Smallest gap between the layout height and the visualViewport that counts as an open on-screen keyboard. iOS keyboards are 250px+;
 *  a smaller gap is browser chrome / a stale value left after the keyboard closed, and must not shrink the shell. */
export const KEYBOARD_MIN_GAP = 150;

/** Height the phone shell should take, px, or null for "use 100dvh". Only an open keyboard (a gap >= KEYBOARD_MIN_GAP) shrinks it. */
export function keyboardShellHeight(vv: { height: number } | null | undefined, innerHeight: number): number | null {
	if (!vv) return null;
	const h = Math.max(0, Math.round(vv.height));
	return innerHeight - h >= KEYBOARD_MIN_GAP ? h : null;
}

/** Label for the control that returns to the list on a phone. */
export const MOBILE_BACK_LABEL = "Back to list";

/** The fixed back-to-list control is needed only on a phone, with the list closed, on a page that mounts no SidebarToggle of its own. */
export const needsFloatingBack = (mobile: boolean, listOpen: boolean, toggles: number): boolean => mobile && !listOpen && toggles === 0;
