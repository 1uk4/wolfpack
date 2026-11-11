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

/** Top offset of the phone shell, px: while the keyboard is open iOS pans the visual viewport inside the layout viewport (offsetTop > 0),
 *  and a `position: fixed` shell pinned at top:0 then sits partly off-screen with its composer still under the keyboard. 0 otherwise. */
export function keyboardShellTop(vv: { height: number; offsetTop: number } | null | undefined, innerHeight: number): number {
	if (!vv || keyboardShellHeight(vv, innerHeight) === null) return 0;
	return Math.max(0, Math.round(vv.offsetTop));
}

/** Bottom padding of the thread, as a CSS length: iOS keeps reporting the home-indicator inset (~34pt) while the keyboard is open, but the
 *  keyboard covers the indicator, so an open keyboard gets 0 (the composer sits on it); otherwise exactly one inset. */
export function shellBottomInset(vv: { height: number } | null | undefined, innerHeight: number): string {
	return keyboardShellHeight(vv, innerHeight) === null ? "env(safe-area-inset-bottom)" : "0px";
}

/** Whether the thread composer takes focus when the page loads. A touch device (coarse pointer) must not: focusing on load opens the iOS
 *  keyboard, which pans the standalone PWA and leaves a body-coloured band under the page (owner, 2026-11-11). Desktop keeps it. */
export const shouldAutoFocusComposer = ({ coarse }: { coarse: boolean }): boolean => !coarse;

/** Label for the control that returns to the list on a phone. */
export const MOBILE_BACK_LABEL = "Back to list";

/** The fixed back-to-list control is needed only on a phone, with the list closed, on a page that mounts no SidebarToggle of its own.
 *  Never on the home page "/": it is the app's start, so there is nothing to go back to. */
export const needsFloatingBack = (mobile: boolean, listOpen: boolean, toggles: number, path = ""): boolean => mobile && !listOpen && toggles === 0 && path !== "/";
