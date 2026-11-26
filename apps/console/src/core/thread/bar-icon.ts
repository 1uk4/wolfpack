/**
 * The floating chat's collapsed state: a small round icon you can drag. PURE: no React, no DOM (storage and the viewport are passed in).
 * The position is the icon's top-left corner in CSS px, remembered per device (never synced). Collapsing itself is the old
 * "minimized" flag (MINIMIZED_KEY in chat-bar.ts, same stored value), so a bar minimized before this change comes back as the icon.
 */
import type { KeyValueStore } from "./chat-bar.ts";

export const ICON_POS_KEY = "wolfpack:chatbar:icon-pos";
/** The icon's diameter (px): above the 44px touch minimum. */
export const ICON_SIZE = 48;
/** The gap kept between the icon and the screen edge or safe-area inset. */
export const ICON_MARGIN = 8;
/** Pointer travel (px) up to which a press is still a tap; past it the press is a drag. */
export const DRAG_THRESHOLD = 6;

export interface IconPos {
	x: number;
	y: number;
}
export interface Viewport {
	width: number;
	height: number;
}
/** env(safe-area-inset-*) in px. */
export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

const bounds = (vp: Viewport, insets: Insets) => ({
	minX: insets.left + ICON_MARGIN,
	maxX: Math.max(insets.left + ICON_MARGIN, vp.width - insets.right - ICON_SIZE - ICON_MARGIN),
	minY: insets.top + ICON_MARGIN,
	maxY: Math.max(insets.top + ICON_MARGIN, vp.height - insets.bottom - ICON_SIZE - ICON_MARGIN),
});

/** Keep the icon fully on screen, inside the safe area. */
export function clampIconPos(pos: IconPos, vp: Viewport, insets: Insets = NO_INSETS): IconPos {
	const b = bounds(vp, insets);
	return { x: Math.min(b.maxX, Math.max(b.minX, pos.x)), y: Math.min(b.maxY, Math.max(b.minY, pos.y)) };
}

/** Where the icon sits before the owner moves it: the bottom-right corner. */
export function defaultIconPos(vp: Viewport, insets: Insets = NO_INSETS): IconPos {
	const b = bounds(vp, insets);
	return { x: b.maxX, y: b.maxY };
}

/** The nearer left or right screen edge (by the icon's centre), height kept (clamped). The phone calls this when a drag ends. */
export function snapIconToEdge(pos: IconPos, vp: Viewport, insets: Insets = NO_INSETS): IconPos {
	const b = bounds(vp, insets);
	const clamped = clampIconPos(pos, vp, insets);
	const centre = clamped.x + ICON_SIZE / 2;
	const mid = (insets.left + vp.width - insets.right) / 2;
	return { x: centre < mid ? b.minX : b.maxX, y: clamped.y };
}

/** More than DRAG_THRESHOLD px of travel from where the press began. */
export const isDrag = (dx: number, dy: number): boolean => Math.hypot(dx, dy) > DRAG_THRESHOLD;

/** The remembered position, clamped to today's viewport (it may have shrunk since); the default corner when none or unreadable. */
export function loadIconPos(s: KeyValueStore | null, vp: Viewport, insets: Insets = NO_INSETS): IconPos {
	try {
		const raw = s?.getItem(ICON_POS_KEY);
		if (raw) {
			const v = JSON.parse(raw) as Partial<IconPos>;
			if (typeof v.x === "number" && typeof v.y === "number" && Number.isFinite(v.x) && Number.isFinite(v.y)) return clampIconPos({ x: v.x, y: v.y }, vp, insets);
		}
	} catch {
		/* fall through to the default */
	}
	return defaultIconPos(vp, insets);
}

export function saveIconPos(s: KeyValueStore | null, pos: IconPos): void {
	try {
		s?.setItem(ICON_POS_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
	} catch {
		/* best effort */
	}
}
