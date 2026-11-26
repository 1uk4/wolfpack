/** A frame always loads from the thread's own wolf, however the view was opened (URL, restored stack, card or pinned open): never /api/wolves//. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
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
	Node: dom.window.Node,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: storage,
});

const { ViewerPanel } = await import("../../../components/viewer/viewer-panel.tsx");
await import("../../../components/viewer/register-renderers.ts");
const { pageHost } = await import("../../../components/viewer/viewer-host.ts");
const vs = await import("../../../components/viewer/viewer-store.ts");
const { FakeNav } = await import("../../helpers/fake-nav.tsx");

let root: Root | null = null;
let calls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
	calls = [];
	(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
	globalThis.fetch = (async (url: string) => {
		calls.push(String(url));
		return new Response("<p>hi</p>", { status: 200 });
	}) as typeof fetch;
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	ls.clear();
	vs.resetViewerCache();
	globalThis.fetch = realFetch;
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
async function mount(start: string, panel: React.ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start={start}>{panel}</FakeNav>));
	await flush();
}
const HAL = "/api/wolves/hal/frame-file?path=progress.html";

describe("frame view on a thread", () => {
	it("opened from ?view=frame:<path> (reload or shared link) fetches the thread's wolf", async () => {
		await mount("/t?view=frame%3Aprogress.html", <ViewerPanel wolf="hal" threadId="t1" />);
		assert.deepEqual(calls, [HAL]);
	});

	it("restored from a saved stack without a wolf fetches the thread's wolf", async () => {
		vs.setViewerState("hal", "t1", { stack: [{ kind: "frame", id: "progress.html" }], open: true });
		await mount("/t", <ViewerPanel wolf="hal" threadId="t1" />);
		assert.deepEqual(calls, [HAL]);
	});

	it("opened from a card or the pinned strip (openView with no wolf) fetches the thread's wolf", async () => {
		await mount("/t", <ViewerPanel wolf="hal" threadId="t1" />);
		await act(async () => vs.openView("hal", "t1", { kind: "frame", id: "progress.html", title: "Progress" }));
		await flush();
		assert.deepEqual(calls, [HAL]);
	});

	it("on a host with no wolf shows a clear error and never fetches", async () => {
		vs.setViewerState("page", "p1", { stack: [{ kind: "frame", id: "progress.html" }], open: true });
		await mount("/p", <ViewerPanel host={pageHost("p1", "all", false)} />);
		assert.deepEqual(calls, []);
		const err = document.querySelector('[data-testid="frame-error"]') as HTMLElement;
		assert.match(err.textContent ?? "", /no wolf/i);
		assert.equal(err.getAttribute("data-gone"), null);
	});
});
