/**
 * The KB pages (topic page, KB activity, KB graph) mount a page viewer with scope "kb": an in-page entry click opens the
 * entry in the viewer instead of navigating; modified clicks and direct URLs keep navigating.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const mem = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event,
	KeyboardEvent: dom.window.KeyboardEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
	IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
	sessionStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
});

const { TopicPage } = await import("../../../components/memory/topic-page.tsx");
const { KbActivityView } = await import("../../../components/kb/kb-activity-view.tsx");
const { openNodeInViewer } = await import("../../../components/graph/graph-view.tsx");
const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { getViewerState, resetViewerCache } = await import("../../../components/viewer/viewer-store.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");
const { kbActivityFixture } = await import("../../fixtures/kb-activity.ts");
const { FakeNav, navLog } = await import("../../helpers/fake-nav.tsx");

const stack = () => getViewerState("page", "kb").stack.map((d) => `${d.kind}:${d.id}`);
let root: Root | null = null;
const realFetch = globalThis.fetch;
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const click = (el: Element, init: Record<string, unknown> = {}) =>
	act(async () => { el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0, ...init })); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

const topicRow = { id: "tp", title: "Topic", bytes: 10, updated: "2026-11-13 10:00", sources: [], state: "promoted", keepLocal: false, entryIds: ["e1"] };
beforeEach(() => {
	mem.clear();
	resetViewerCache();
	dataStore.clear();
	globalThis.fetch = (async (input: string) => {
		const url = String(input);
		if (url.includes("/session-topics")) return Response.json({ topics: [topicRow], retired: [] });
		if (url.includes("/memory/topics/")) return Response.json({ id: "tp", title: "Topic", body: "hello" });
		if (url.includes("/api/kb/activity")) return Response.json(kbActivityFixture());
		return Response.json({}, { status: 404 });
	}) as typeof fetch;
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	globalThis.fetch = realFetch;
});

async function mount(start: string, node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start={start}><ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>{node}</ServerEventsProvider></FakeNav>));
	await flush();
}

describe("KB pages open entries in the page viewer", () => {
	it("topic page: a click on a KB entry id opens kind kb in the shared kb scope without navigating", async () => {
		await mount("/wolf/hal/memory/topic/tp", <TopicPage wolf="hal" id="tp" />);
		await click(q('a[href="/kb/entry/e1"]')!);
		assert.deepEqual(stack(), ["kb:e1"]);
		assert.equal(navLog.stack.length, 1);
	});

	it("cmd-click on an entry link is left to the browser: nothing opens", async () => {
		await mount("/wolf/hal/memory/topic/tp", <TopicPage wolf="hal" id="tp" />);
		const ev = Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0, metaKey: true });
		await act(async () => { q('a[href="/kb/entry/e1"]')!.dispatchEvent(ev); });
		assert.equal(ev.defaultPrevented, false);
		assert.deepEqual(stack(), []);
	});

	it("activity page: a click on a decision row opens that entry in the viewer", async () => {
		await mount("/kb-activity", <KbActivityView />);
		await click(q('a[href="/kb/entry/ent-merge"]')!);
		assert.deepEqual(stack(), ["kb:ent-merge"]);
	});

	it("activity page: ?view=kb:<id> on load opens the entry", async () => {
		await mount("/kb-activity?view=kb:ent-merge", <KbActivityView />);
		assert.deepEqual(stack(), ["kb:ent-merge"]);
		assert.equal(getViewerState("page", "kb").open, true);
	});

	it("graph: an entry node opens kind kb, a work node and a factory node are not handled", () => {
		const opened: string[] = [];
		const open = Object.assign((d: { kind: string; id: string }) => { opened.push(`${d.kind}:${d.id}`); return true; }, { canOpen: () => true });
		assert.equal(openNodeInViewer("ent:x1", open), true);
		assert.equal(openNodeInViewer("fac:d", open), false);
		assert.equal(openNodeInViewer("ent:x1", null), false);
		assert.deepEqual(opened, ["kb:x1"]);
	});
});
