/**
 * Where the floating chat bar (and its icon) must not draw. PURE: the path and the set of "something covers the whole window" flags go in.
 * The bar is otherwise on every page, /chat/new included.
 */
/** Sign-in / pairing: there is no signed-in console to chat from yet. */
const PAIRING = /^\/pair(\/|$)/;

export interface BarHiddenFlags {
	/** The reasons currently hiding the bar (a frame or the graph shown full screen register one each, see components/chat-bar/bar-visibility.ts). */
	reasons: readonly string[];
}

export function barHiddenFor(pathname: string | null, flags: BarHiddenFlags): boolean {
	if (pathname && PAIRING.test(pathname)) return true;
	return flags.reasons.length > 0;
}
