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

function stubDesktop(desktop: boolean) {
	(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: desktop, addEventListener() {}, removeEventListener() {} });
	(dom.window as unknown as Record<string, unknown>).innerWidth = 1400;
}

async function mount() {
	vs.setViewerState("hal", "t1", { stack: [{ kind: "tall", id: "x" }], open: true });
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start="/t"><ViewerPanel wolf="hal" threadId="t1" /></FakeNav>));
}

const ptr = (type: string, clientX: number) => Object.assign(new dom.window.Event(type, { bubbles: true }), { clientX, pointerId: 1 });

describe("viewer resize handle", () => {
	it("is absent in the phone sheet, which ignores the stored width", async () => {
		stubDesktop(false);
		ls.set("wolfpack:viewer:width", "600");
		await mount();
		assert.equal(document.querySelector('[data-testid="viewer-resize"]'), null);
		assert.doesNotMatch((document.querySelector('[data-testid="viewer-panel"]') as HTMLElement).getAttribute("style") ?? "", /600/);
	});

	it("drags the column wider (clamped, persisted, text selection off meanwhile) and double-click resets to 480", async () => {
		stubDesktop(true);
		await mount();
		const h = () => document.querySelector('[data-testid="viewer-resize"]') as HTMLElement;
		const panel = () => document.querySelector('[data-testid="viewer-panel"]') as HTMLElement;
		await act(async () => void h().dispatchEvent(ptr("pointerdown", 900)));
		assert.equal(document.body.style.userSelect, "none");
		await act(async () => void h().dispatchEvent(ptr("pointermove", 800)));
		assert.match(panel().getAttribute("style") ?? "", /580px/);
		await act(async () => void h().dispatchEvent(ptr("pointermove", -5000)));
		assert.match(panel().getAttribute("style") ?? "", /980px/);
		await act(async () => void h().dispatchEvent(ptr("pointerup", -5000)));
		assert.equal(document.body.style.userSelect, "");
		assert.equal(ls.get("wolfpack:viewer:width"), "980");
		await act(async () => void h().dispatchEvent(new dom.window.Event("dblclick", { bubbles: true })));
		assert.match(panel().getAttribute("style") ?? "", /480px/);
		assert.equal(ls.get("wolfpack:viewer:width"), "480");
	});
});

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
