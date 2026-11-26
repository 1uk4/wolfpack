/**
 * Long-press for touch tooltips (look-and-feel: icon-only controls show their tip on hover AND on a phone long-press; Radix tooltips
 * ignore touch). A plain controller with no React in it so the timing is testable: Hint feeds it pointer events.
 *
 * A touch held for `delayMs` calls onOpen, and onClose follows `showMs` later. Moving more than `slopPx`, lifting or cancelling
 * before the delay stops it. The click that ends the press which opened the tip is swallowed once (swallowClick), so the control
 * does not also fire. Mouse and pen never long-press: they have hover and focus.
 */
export const LONG_PRESS_MS = 400;
export const LONG_PRESS_SHOW_MS = 1500;
const SLOP_PX = 10;

export type LongPress = {
	down(e: { pointerType: string; clientX: number; clientY: number }): void;
	move(e: { clientX: number; clientY: number }): void;
	/** Pointer up or cancel. */
	end(): void;
	/** True once after a long-press opened the tip: the click that follows must be dropped. */
	swallowClick(): boolean;
	/** True while a long-press tip is up: Radix's own close (pointerleave after the finger lifts) must not end it early. */
	showing(): boolean;
	/** Close a shown tip now (outside press); no-op when none is up. */
	dismiss(): void;
	dispose(): void;
};

export function createLongPress(onOpen: () => void, onClose: () => void, delayMs = LONG_PRESS_MS, showMs = LONG_PRESS_SHOW_MS): LongPress {
	let hold: ReturnType<typeof setTimeout> | null = null;
	let show: ReturnType<typeof setTimeout> | null = null;
	let origin: { x: number; y: number } | null = null;
	let fired = false;
	const clearHold = () => {
		if (hold) clearTimeout(hold);
		hold = null;
		origin = null;
	};
	return {
		down(e) {
			// Reset first: a mouse click after a touch long-press (hybrid devices) must not be swallowed.
			fired = false;
			if (e.pointerType !== "touch") return;
			clearHold();
			if (show) clearTimeout(show);
			show = null;
			origin = { x: e.clientX, y: e.clientY };
			hold = setTimeout(() => {
				hold = null;
				fired = true;
				onOpen();
				show = setTimeout(() => {
					show = null;
					onClose();
				}, showMs);
			}, delayMs);
		},
		move(e) {
			if (hold && origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > SLOP_PX) clearHold();
		},
		end: clearHold,
		swallowClick() {
			const was = fired;
			fired = false;
			return was;
		},
		showing: () => show !== null,
		dismiss() {
			if (!show) return;
			clearTimeout(show);
			show = null;
			onClose();
		},
		dispose() {
			clearHold();
			if (show) clearTimeout(show);
			show = null;
		},
	};
}
