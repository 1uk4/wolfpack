"use client";

/**
 * The middle column the floating chat bar centres on. A thread page registers its chat column (the element left of the viewer panel);
 * with none registered the column is the app shell's `main`. The rect is {left, width} in viewport px, re-measured once per animation
 * frame when the column resizes, the window resizes, or a transition ends (the sidebar sliding open moves the column without a resize event).
 */
import { useSyncExternalStore } from "react";

export interface ColumnRect {
	left: number;
	width: number;
}

const EMPTY: ColumnRect = { left: 0, width: 0 };
let registered: HTMLElement | null = null;
let rect: ColumnRect = EMPTY;
const subs = new Set<() => void>();
let ro: ResizeObserver | null = null;
let observed: Element | null = null;
let frame = 0;

const target = (): Element | null => registered ?? (typeof document === "undefined" ? null : document.querySelector("main"));

function measure() {
	const r = target()?.getBoundingClientRect() ?? EMPTY; // nothing to measure: back to "unknown", so the bar centres on the window
	if (r.left === rect.left && r.width === rect.width) return;
	rect = { left: r.left, width: r.width };
	for (const cb of subs) cb();
}
const schedule = () => {
	if (frame) return;
	frame = requestAnimationFrame(() => {
		frame = 0;
		measure();
	});
};
function observeTarget() {
	const el = target();
	if (el === observed) return;
	if (observed) ro?.unobserve(observed);
	observed = el;
	if (el) ro?.observe(el);
}

/** A thread page hands over its chat column (null on unmount: the bar goes back to `main`). */
export function registerColumn(el: HTMLElement | null): void {
	if (registered === el) return;
	registered = el;
	if (subs.size > 0) {
		observeTarget();
		schedule();
	}
}

function subscribe(cb: () => void): () => void {
	if (subs.size === 0) {
		ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
		window.addEventListener("resize", schedule);
		document.addEventListener("transitionend", schedule, true);
		observeTarget();
		measure();
	}
	subs.add(cb);
	return () => {
		subs.delete(cb);
		if (subs.size > 0) return;
		ro?.disconnect();
		ro = null;
		observed = null;
		window.removeEventListener("resize", schedule);
		document.removeEventListener("transitionend", schedule, true);
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	};
}

/** The column's rect; width 0 until something is measured (barGeometry then centres on the window). */
export function useColumnRect(): ColumnRect {
	return useSyncExternalStore(subscribe, () => rect, () => EMPTY);
}
