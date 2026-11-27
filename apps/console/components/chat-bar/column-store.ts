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
/** A side panel that sits over the column's right side (the work reader): the column ends at its left edge. */
let cover: HTMLElement | null = null;

/** The column cut at a covering panel's left edge; unchanged when there is no panel, it lies past the column, or it would leave nothing. */
export function clipColumn(col: ColumnRect, coverLeft: number | null): ColumnRect {
	if (coverLeft === null || coverLeft >= col.left + col.width || coverLeft <= col.left) return col;
	return { left: col.left, width: coverLeft - col.left };
}
let rect: ColumnRect = EMPTY;
const subs = new Set<() => void>();
let ro: ResizeObserver | null = null;
let observed: Element | null = null;
let frame = 0;

const target = (): Element | null => registered ?? (typeof document === "undefined" ? null : document.querySelector("main"));

function measure() {
	const r = target()?.getBoundingClientRect() ?? EMPTY; // nothing to measure: back to "unknown", so the bar centres on the window
	const c = clipColumn({ left: r.left, width: r.width }, cover && r.width > 0 ? cover.getBoundingClientRect().left : null);
	if (c.left === rect.left && c.width === rect.width) return;
	rect = c;
	for (const cb of subs) cb();
}
/** A transition that can move the column is one on the column or an element holding it; every other transition on the page (hover fades) is ignored. */
const onTransitionEnd = (e: Event) => {
	const col = target();
	if (col && e.target instanceof Node && e.target.contains(col)) schedule();
};
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

/** A side panel over the column's right side hands over its element (null on unmount): the bar centres left of it. */
export function registerCover(el: HTMLElement | null): void {
	if (cover === el) return;
	if (cover && ro) ro.unobserve(cover);
	cover = el;
	if (el && ro) ro.observe(el);
	if (subs.size > 0) schedule();
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
		document.addEventListener("transitionend", onTransitionEnd, true);
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
		document.removeEventListener("transitionend", onTransitionEnd, true);
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	};
}

/** The column's rect; width 0 until something is measured (barGeometry then centres on the window). */
export function useColumnRect(): ColumnRect {
	return useSyncExternalStore(subscribe, () => rect, () => EMPTY);
}
