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

/** Where the icon sits before the owner moves it: bottom centre, of the page column when `centreX` (the column's middle, px) is given, else of the window. */
export function defaultIconPos(vp: Viewport, insets: Insets = NO_INSETS, centreX: number = vp.width / 2): IconPos {
	const b = bounds(vp, insets);
	return { x: Math.min(b.maxX, Math.max(b.minX, centreX - ICON_SIZE / 2)), y: b.maxY };
}

const offScreen = (pos: IconPos, vp: Viewport): boolean => pos.x < 0 || pos.y < 0 || pos.x + ICON_SIZE > vp.width || pos.y + ICON_SIZE > vp.height;

/** The phone's collapsed icon: always the bottom centre of the safe area (not draggable, no remembered spot), so it never covers the page's bottom corner controls. */
export function phoneIconPos(vp: Viewport, insets: Insets = NO_INSETS): IconPos {
	return defaultIconPos(vp, insets, (insets.left + vp.width - insets.right) / 2);
}

/** More than DRAG_THRESHOLD px of travel from where the press began. */
export const isDrag = (dx: number, dy: number): boolean => Math.hypot(dx, dy) > DRAG_THRESHOLD;

/** The remembered position; a spot now off-screen (the window shrank since) snaps back to the default bottom centre; the default also when none or unreadable. */
export function loadIconPos(s: KeyValueStore | null, vp: Viewport, insets: Insets = NO_INSETS, centreX?: number): IconPos {
	try {
		const raw = s?.getItem(ICON_POS_KEY);
		if (raw) {
			const v = JSON.parse(raw) as Partial<IconPos>;
			if (typeof v.x === "number" && typeof v.y === "number" && Number.isFinite(v.x) && Number.isFinite(v.y)) {
				const saved = { x: v.x, y: v.y };
				return offScreen(saved, vp) ? defaultIconPos(vp, insets, centreX) : clampIconPos(saved, vp, insets);
			}
		}
	} catch {
		/* fall through to the default */
	}
	return defaultIconPos(vp, insets, centreX);
}

export function saveIconPos(s: KeyValueStore | null, pos: IconPos): void {
	try {
		s?.setItem(ICON_POS_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
	} catch {
		/* best effort */
	}
}
