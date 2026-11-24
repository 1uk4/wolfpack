/** Viewer panel layout: the body is the scroll container, and the desktop column has a resize handle the sheet lacks. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).self ??= globalThis;
const ls = new Map<string, string>();
const storage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) };
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage: storage }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: storage,
});

const { ViewerPanel } = await import("../../../components/viewer/viewer-panel.tsx");
const { registerViewRenderer } = await import("../../../components/viewer/registry.tsx");
const vs = await import("../../../components/viewer/viewer-store.ts");
const { FakeNav } = await import("../../helpers/fake-nav.tsx");

registerViewRenderer("tall", () => <div style={{ height: 5000 }}>tall content</div>);

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	ls.clear();
	vs.resetViewerCache();
});

async function mount() {
	vs.setViewerState("hal", "t1", { stack: [{ kind: "tall", id: "x" }], open: true });
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start="/t"><ViewerPanel wolf="hal" threadId="t1" /></FakeNav>));
}

describe("viewer panel body", () => {
	it("is the scroll container: a tall view scrolls inside the body, not clipped", async () => {
		await mount();
		const body = document.querySelector('[data-testid="viewer-body"]') as HTMLElement;
		const cls = body.className.split(/\s+/);
		assert.ok(cls.includes("overflow-y-auto"), body.className);
		assert.ok(cls.includes("min-h-0") && cls.includes("flex-1"), body.className);
		assert.ok(!cls.includes("overflow-hidden"), body.className);
		assert.match(body.textContent ?? "", /tall content/);
	});
});
