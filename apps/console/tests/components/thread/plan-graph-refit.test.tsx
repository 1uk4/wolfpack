/** The zoomable graph refits (zoom to fit) when its box changes width (a side panel opening), unless the user zoomed or panned by hand since the last fit. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const callbacks: Array<() => void> = [];
const box = { w: 1000, h: 600 };
Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => box.w });
Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => box.h });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { constructor(cb: () => void) { callbacks.push(cb); } observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
	localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

const { PlanGraphView } = await import("../../../components/thread/plan-graph-view.tsx");

const data = {
	nodes: [
		{ id: "a", label: "A", kind: "step", status: "todo" as const },
		{ id: "b", label: "B", kind: "step", status: "todo" as const },
		{ id: "c", label: "C", kind: "step", status: "todo" as const },
		{ id: "d", label: "D", kind: "step", status: "todo" as const },
	],
	edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }],
};
let root: Root | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	callbacks.length = 0;
	box.w = 1000;
});
async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<PlanGraphView graph={data} label="g" draggable zoomable fill toolbarAbove nodeSize={{ width: 176, height: 68 }} />));
}
const pan = () => document.querySelector('[data-testid="graph-pan"]') as HTMLElement;
const view = () => `${pan().getAttribute("data-zoom")}@${pan().getAttribute("data-pan-x")}`;
const resize = (w: number) => act(async () => { box.w = w; for (const cb of callbacks) cb(); });

describe("zoomable graph refit on resize", () => {
	it("refits when the box gets narrower", async () => {
		await mount();
		const zoom = view;
		const wide = zoom();
		await resize(400);
		assert.equal(wide, "1@94");
		assert.equal(zoom(), "1@8"); // zoom 1 is the cap; the pan re-centres the graph in the narrower box
	});

	it("does not refit after the user zoomed by hand", async () => {
		await mount();
		await act(async () => void (document.querySelector('[data-testid="graph-zoom-in"]') as HTMLElement).dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
		const zoomed = view();
		await resize(400);
		assert.equal(view(), zoomed);
	});
});
