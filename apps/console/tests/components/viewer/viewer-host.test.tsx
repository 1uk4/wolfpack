/** Viewer hosts: the thread host keeps today's storage key; a page host has its own key, no pins, no show_view arrivals, an allow-list, and ?view= sync. */
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
	window: Object.assign(dom.window, { localStorage: storage, location: { pathname: "/kb", search: "", href: "/kb" } }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: storage,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const { threadHost, pageHost, hostStoreKey } = await import("../../../components/viewer/viewer-host.ts");
const { PageViewer } = await import("../../../components/viewer/page-viewer.tsx");
const { ViewerPanel } = await import("../../../components/viewer/viewer-panel.tsx");
const { ViewerProvider } = await import("../../../components/viewer/viewer-context.tsx");
const { registerViewRenderer } = await import("../../../components/viewer/registry.tsx");
const vs = await import("../../../components/viewer/viewer-store.ts");
const { WorkIdChip, resetWorkLookupCache } = await import("../../../components/work/work-id-chip.tsx");
const { ViewCard } = await import("../../../components/thread/view-card.tsx");
const { dataStore } = await import("../../../src/core/data-store.ts");
const { FakeNav, navLog, currentUrl } = await import("../../helpers/fake-nav.tsx");

registerViewRenderer("work", () => <div>work body</div>);
registerViewRenderer("kb", () => <div>kb body</div>);

const ID = "work-wolfpack-cEg92qS";
let root: Root | null = null;
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const ev = (type: string, init: Record<string, unknown> = {}) => Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { button: 0, ...init });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function mount(start: string, node: React.ReactNode) {
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	await act(async () => root!.render(<FakeNav start={start}>{node}</FakeNav>));
}

beforeEach(() => {
	(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
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
	ls.clear();
	vs.resetViewerCache();
});

describe("host storage keys", () => {
	it("the thread host keeps today's key; a page host lives under wolfpack:viewer:page:<scope>", () => {
		assert.equal(hostStoreKey(threadHost("hal", "t1")), "wolfpack:viewer:hal:t1");
		assert.equal(hostStoreKey(pageHost("settings:hal", "all")), "wolfpack:viewer:page:settings:hal");
		const t = threadHost("hal", "t1");
		assert.deepEqual({ pins: t.pins, urlSync: t.urlSync, viewObjects: t.viewObjects }, { pins: true, urlSync: true, viewObjects: true });
		const p = pageHost("work", ["kb"]);
		assert.deepEqual({ id: p.id, pins: p.pins, urlSync: p.urlSync, viewObjects: p.viewObjects }, { id: "page:work", pins: false, urlSync: true, viewObjects: false });
	});
});

describe("page host", () => {
	it("opens from a chip in its own stack (never the thread's), shows no pin button, and Esc closes it", async () => {
		await mount("/work", <PageViewer scope="work" allowedKinds="all"><WorkIdChip id={ID} /></PageViewer>);
		await act(async () => void q("[data-work-id]")!.dispatchEvent(ev("click")));
		await flush();
		assert.deepEqual(vs.getViewerState("page", "work").stack.map((d) => d.id), [ID]);
		assert.deepEqual(vs.getViewerState("hal", "work").stack, []);
		assert.notEqual(q('[data-testid="viewer-panel"]'), null);
		assert.equal(q('[data-testid="viewer-pin"]'), null);
		await act(async () => void window.dispatchEvent(ev("keydown", { key: "Escape" })));
		assert.equal(q('[data-testid="viewer-panel"]'), null);
		vs.flushViewer();
		assert.equal(ls.has("wolfpack:viewer:page:work"), true);
		assert.equal(ls.has("wolfpack:viewer:hal:work"), false);
	});

	it("a thread host and a page host never share state, and only the thread host pins", async () => {
		vs.setViewerState("hal", "t1", { stack: [{ kind: "kb", id: "a" }], open: true });
		vs.setViewerState("page", "t1", { stack: [{ kind: "kb", id: "b" }], open: true });
		await mount("/t", <ViewerPanel wolf="hal" threadId="t1" />);
		assert.equal(q('[data-testid="viewer-title"]')!.textContent, "a");
		assert.notEqual(q('[data-testid="viewer-pin"]'), null);
	});

	it("a kind outside allowedKinds is not handled: the work chip navigates as normal and the stack stays empty", async () => {
		await mount("/kb", <PageViewer scope="kb" allowedKinds={["kb"]}><WorkIdChip id={ID} /></PageViewer>);
		await act(async () => void q("[data-work-id]")!.dispatchEvent(ev("keydown", { key: "Enter" })));
		await flush();
		await act(async () => void q('[data-testid="work-card-work"]')!.dispatchEvent(ev("click")));
		assert.deepEqual(vs.getViewerState("page", "kb").stack, []);
		assert.equal(navLog.stack.length, 2);
	});

	it("ignores show_view cards: a view card inside a page host opens nothing", async () => {
		await mount("/work", <PageViewer scope="work" allowedKinds="all"><ViewCard objectId="v1" type="view" rev={1} data={{ kind: "kb", id: "e1" }} /></PageViewer>);
		await act(async () => void q('[data-testid="view-card"]')!.dispatchEvent(ev("click")));
		assert.deepEqual(vs.getViewerState("page", "work").stack, []);
		assert.equal(q('[data-testid="viewer-panel"]'), null);
	});

	it("reads ?view= on load and writes it back with replace", async () => {
		await mount("/work?view=kb%3Ae1", <PageViewer scope="work" allowedKinds="all"><span /></PageViewer>);
		assert.equal(q('[data-testid="viewer-title"]')!.textContent, "e1");
		await act(async () => void q('[data-testid="viewer-close"]')!.dispatchEvent(ev("click")));
		assert.equal(currentUrl(), "/work");
		assert.equal(navLog.stack.length, 1);
	});

	it("a ?view= of a disallowed kind is ignored on load", async () => {
		await mount("/kb?view=work%3Awork-wolfpack-x", <PageViewer scope="kb" allowedKinds={["kb"]}><span /></PageViewer>);
		assert.equal(q('[data-testid="viewer-panel"]'), null);
	});
});

describe("thread host provider", () => {
	it("still opens any kind (wolf/threadId props)", async () => {
		await mount("/t", <ViewerProvider wolf="hal" threadId="t1"><WorkIdChip id={ID} /></ViewerProvider>);
		await act(async () => void q("[data-work-id]")!.dispatchEvent(ev("click")));
		assert.deepEqual(vs.getViewerState("hal", "t1").stack.map((d) => d.id), [ID]);
	});
});
