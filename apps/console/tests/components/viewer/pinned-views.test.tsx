/** Pinned view chips in the thread's pinned strip, and the viewer header's pin toggle. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).self ??= globalThis;
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const { PinnedViewChips } = await import("../../../components/thread/pinned-views.tsx");
const { PinViewButton } = await import("../../../components/viewer/viewer-panel.tsx");
const ps = await import("../../../components/thread/pin-store.ts");
const vs = await import("../../../components/viewer/viewer-store.ts");

let root: Root | null = null;
beforeEach(() => {
	store.clear();
	ps.resetPinnedViewsCache();
	vs.resetViewerCache();
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

async function mount(el: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(el));
}
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const click = (el: HTMLElement | null) => act(async () => void el!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));

describe("pinned view chips", () => {
	it("shows a chip per pinned view with its title (id as fallback), opens the viewer on click, and unpins with the x", async () => {
		ps.pinView("t1", { kind: "work", id: "w1", title: "Fix the thing" });
		ps.pinView("t1", { kind: "kb", id: "k1" });
		ps.pinView("t2", { kind: "kb", id: "other" });
		await mount(<PinnedViewChips wolf="hal" threadId="t1" />);
		const chips = [...document.querySelectorAll('[data-testid="pinned-view-chip"]')].map((c) => c.textContent);
		assert.deepEqual(chips, ["Fix the thing", "k1"]);

		await click(q('[data-view-key="work:w1"] [data-testid="pinned-view-open"]'));
		const s = vs.getViewerState("hal", "t1");
		assert.equal(s.open, true);
		assert.deepEqual(s.stack.map((d) => `${d.kind}:${d.id}`), ["work:w1"]);

		await click(q('[data-view-key="kb:k1"] [data-testid="pinned-view-unpin"]'));
		assert.deepEqual(ps.getPinnedViews("t1").map((d) => d.id), ["w1"]);
		assert.equal(q('[data-view-key="kb:k1"]'), null);
	});
});

describe("viewer header pin button", () => {
	it("toggles the pin of the shown view, storing its title", async () => {
		await mount(<PinViewButton threadId="t1" descriptor={{ kind: "work", id: "w1" }} title="Shown title" />);
		const btn = () => q('[data-testid="viewer-pin"]');
		assert.equal(btn()!.getAttribute("aria-pressed"), "false");
		await click(btn());
		assert.deepEqual(ps.getPinnedViews("t1"), [{ kind: "work", id: "w1", title: "Shown title" }]);
		assert.equal(btn()!.getAttribute("aria-pressed"), "true");
		await click(btn());
		assert.deepEqual(ps.getPinnedViews("t1"), []);
		assert.equal(btn()!.getAttribute("aria-pressed"), "false");
	});
});
