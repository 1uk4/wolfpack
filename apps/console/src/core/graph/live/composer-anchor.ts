/**
 * Where the live graph's chat tether anchors: PURE (rects in, rect out; no DOM).
 * The anchor is the first visible chat element (the collapsed icon, or the open bar). A rect that is empty, non-finite or sitting
 * exactly at the viewport origin is a hidden / mid-mount element (getBoundingClientRect gives 0,0): it is ignored and the last good
 * anchor is kept, so the line never jumps to the top-left corner. No element at all (no chat on the page) gives null.
 */
export interface RectLike {
	left: number;
	top: number;
	width: number;
	height: number;
}
export interface Anchor {
	x: number;
	y: number;
	w: number;
	h: number;
}

const usable = (r: RectLike): boolean =>
	[r.left, r.top, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 && !(r.left === 0 && r.top === 0);

export function pickComposerAnchor(wrap: RectLike, candidates: readonly (RectLike | null | undefined)[], last: Anchor | null): Anchor | null {
	if (!candidates.some(Boolean)) return null;
	if (!Number.isFinite(wrap.left) || !Number.isFinite(wrap.top) || wrap.width <= 0 || wrap.height <= 0) return last;
	for (const r of candidates) {
		if (r && usable(r)) return { x: r.left - wrap.left, y: r.top - wrap.top, w: r.width, h: r.height };
	}
	return last;
}

/** Frames the anchor must hold still before measuring stops. */
export const SETTLE_FRAMES = 4;
/** Measuring stops after this many frames even if it never settles (a ~200ms slide is about 12 frames). */
export const SETTLE_MAX_FRAMES = 60;

export interface SettleState {
	anchor: Anchor | null;
	still: number;
}

/** Count the consecutive frames the anchor read the same: the icon slides (left/top transition) and a ResizeObserver never fires for a move, so one mid-slide read must not stay the anchor. */
export function trackSettle(s: SettleState, a: Anchor | null): SettleState {
	const same = !!a && !!s.anchor && a.x === s.anchor.x && a.y === s.anchor.y && a.w === s.anchor.w && a.h === s.anchor.h;
	return { anchor: a, still: same ? s.still + 1 : 0 };
}
