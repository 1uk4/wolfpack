/** Thread-page viewer triggers: work chip click, hover-card Open and KB links in messages open the viewer inside a ViewerProvider. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const mem = new Map<string, string>();
Object.assign(dom.window, { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const { WorkIdChip, resetWorkLookupCache } = await import("../../../components/work/work-id-chip.tsx");
const { MessageResponse } = await import("../../../components/ai-elements/message.tsx");
const { ViewerProvider } = await import("../../../components/viewer/viewer-context.tsx");
const { getViewerState, resetViewerCache } = await import("../../../components/viewer/viewer-store.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");
const { FakeNav, navLog } = await import("../../helpers/fake-nav.tsx");

const ID = "work-wolfpack-cEg92qS";
const stack = () => getViewerState("hal", "t1").stack.map((d) => `${d.kind}:${d.id}`);
let root: Root | null = null;
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const ev = (type: string, init: Record<string, unknown> = {}) => Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { button: 0, ...init });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function mount(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start="/wolf/hal/thread/t1">{node}</FakeNav>));
}
beforeEach(() => {
	mem.clear();
	resetViewerCache();
	resetWorkLookupCache();
	dataStore.clear();
	(globalThis as Record<string, unknown>).fetch = async (url: string) =>
		String(url) === "/api/wolves"
			? Response.json({ wolves: [{ id: "1", name: "hal", host: "h", status: "online", librarian: true }] })
			: String(url).includes(`/work/${ID}/record`)
				? Response.json({ id: ID, title: "T", kind: "task", stage: "building", domain: "wolfpack", plan: "", record: "" })
				: Response.json({ error: "nope" }, { status: 404 });
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("viewer triggers on the thread page", () => {
	it("clicking a work chip opens the viewer on the item and leaves the hover card closed", async () => {
		await mount(<ViewerProvider wolf="hal" threadId="t1"><WorkIdChip id={ID} /></ViewerProvider>);
		await act(async () => void q("[data-work-id]")!.dispatchEvent(ev("click")));
		await flush();
		assert.deepEqual(stack(), [`work:${ID}`]);
		assert.equal(q('[data-testid="work-card"]'), null);
	});

	it("the hover card's Open opens the viewer instead of navigating", async () => {
		await mount(<ViewerProvider wolf="hal" threadId="t1"><WorkIdChip id={ID} /></ViewerProvider>);
		await act(async () => void q("[data-work-id]")!.dispatchEvent(ev("keydown", { key: "Enter" })));
		await flush();
		await act(async () => void q('[data-testid="work-card-work"]')!.dispatchEvent(ev("click")));
		assert.deepEqual(stack(), [`work:${ID}`]);
		assert.equal(navLog.stack.length, 1);
	});

	it("a KB entry link in a message opens the viewer and does not navigate; modified clicks are left alone", async () => {
		await mount(
			<ViewerProvider wolf="hal" threadId="t1">
				<MessageResponse mode="static">{"See [the entry](/kb/entry/e9) and [other](/kb/entry/e8)."}</MessageResponse>
			</ViewerProvider>,
		);
		const e = ev("click");
		await act(async () => void q('a[href="/kb/entry/e9"]')!.dispatchEvent(e));
		await act(async () => void q('a[href="/kb/entry/e8"]')!.dispatchEvent(ev("click", { metaKey: true })));
		assert.deepEqual(stack(), ["kb:e9"]);
		assert.equal(e.defaultPrevented, true);
	});
});
