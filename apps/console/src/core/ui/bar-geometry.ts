/**
 * Where the floating chat bar sits on desktop: centred on the page's middle column (the chat column on a thread page, `main` elsewhere),
 * at most `cap` wide, `gap` clear of the column's edges. PURE: the column's measured rect and the viewport go in, inline styles come out.
 */
export interface BarGeometryInput {
	colLeft: number;
	colWidth: number;
	viewportWidth: number;
	/** The widest the bar grows (px). */
	cap?: number;
	/** The room kept between the bar and the column's edges (px). */
	gap?: number;
}
export interface BarGeometry {
	/** The bar's horizontal centre (px from the viewport's left edge); apply as `left` with translateX(-50%). */
	left: number;
	width: number;
	/** Too narrow for the full header: the secondary controls move into the overflow menu. */
	compact: boolean;
}

export const BAR_CAP = 900;
export const BAR_GAP = 16;
/** Below this width the bar header runs out of room for gear, shrink, eye and swap. */
export const BAR_COMPACT_BELOW = 460;
/** The bar never gets narrower than this (or the window minus two gaps): a squeezed column is overlapped, not obeyed. */
export const MIN_BAR = 420;

export function barGeometry({ colLeft, colWidth, viewportWidth, cap = BAR_CAP, gap = BAR_GAP }: BarGeometryInput): BarGeometry {
	// A column that is unmeasured, or wider than the window (a horizontally scrolling page), says nothing about the screen: centre on the window.
	const usable = Number.isFinite(colLeft) && colWidth > 0 && colWidth <= viewportWidth;
	let left = usable ? colLeft + colWidth / 2 : viewportWidth / 2;
	const room = (usable ? colWidth : viewportWidth) - 2 * gap;
	const floor = Math.max(0, Math.min(MIN_BAR, viewportWidth - 2 * gap));
	const width = Math.max(floor, Math.min(cap, room));
	// Centre on the column, but keep the whole bar on screen (gap clear of both window edges).
	const lo = width / 2 + gap;
	const hi = viewportWidth - width / 2 - gap;
	return { left: lo <= hi ? Math.min(hi, Math.max(lo, left)) : viewportWidth / 2, width, compact: width < BAR_COMPACT_BELOW };
}
