/**
 * The split of the Work list and the Graph: the reader panel (URL-driven, full screen on phones), the graph's
 * work-node click, the two sidebar links, and the deep links that keep working. The list's own behaviour is in
 * work-view.test.tsx.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" }),
});

const { FakeNav } = await import("./helpers/fake-nav.tsx");
const { WorkReaderPanel, readerUrl } = await import("../components/work-reader.tsx");
const { nodeClickAction } = await import("../components/graph-view.tsx");
const { WorkNavEntry } = await import("../components/work-view-entry.tsx");
const { WorkItemView } = await import("../components/work-item-page.tsx");
const { EntryReaderView } = await import("../components/entry-reader.tsx");

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("the reader URL", () => {
	it("adds and removes ?item= and keeps the page's other params", () => {
		assert.equal(readerUrl("/work", "", "f1"), "/work?item=f1");
		assert.equal(readerUrl("/", "focus=work%3Aa", "f1"), "/?focus=work%3Aa&item=f1");
		assert.equal(readerUrl("/work", "item=f1", null), "/work");
		assert.equal(readerUrl("/", "focus=x&item=f1", null), "/?focus=x");
	});
});

describe("Esc", () => {
	it("closes only the reader: a window capture listener that claims the event (preventDefault + stopPropagation)", async () => {
		let closed = 0;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/work"><WorkReaderPanel id="f1" onClose={() => closed++} /></FakeNav>));
		let ev!: Event;
		let stopped = false;
		await act(async () => {
			ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(ev, "key", { value: "Escape" });
			const stop = ev.stopPropagation.bind(ev);
			ev.stopPropagation = () => { stopped = true; stop(); };
			window.dispatchEvent(ev);
		});
		assert.equal(closed, 1);
		assert.ok(ev.defaultPrevented && stopped, "claimed in the capture phase, so the page's own Esc handling does not also act");
		// listener removed on unmount: a later Esc is the page's again
		await act(async () => root!.unmount());
		root = null;
		await act(async () => {
			const e2 = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(e2, "key", { value: "Escape" });
			window.dispatchEvent(e2);
		});
		assert.equal(closed, 1);
	});
});

describe("phones", () => {
	it("the reader is full screen under 768px: inset-0, h-dvh, full width, safe-area padding, a 44px close button", () => {
		const html = renderToStaticMarkup(<FakeNav start="/work"><WorkReaderPanel id="f1" onClose={() => {}} /></FakeNav>);
		for (const c of ["max-md:inset-0", "max-md:h-dvh", "max-md:w-full", "max-md:pt-[env(safe-area-inset-top)]", "max-md:pb-[env(safe-area-inset-bottom)]"]) assert.ok(html.includes(c), c);
		const view = renderToStaticMarkup(<WorkItemView id="f1" state={{ kind: "loading" }} onClose={() => {}} />);
		assert.ok(view.includes('data-testid="work-reader-close"') && view.includes("max-md:size-11"));
	});
	it("the KB entry reader is full screen too", () => {
		const html = renderToStaticMarkup(<EntryReaderView id="x" state={{ kind: "loading" }} overlay={{ onClose: () => {} }} />);
		assert.ok(html.includes("max-md:inset-0") && html.includes("max-md:w-full") && html.includes("max-md:size-11"));
	});
	it("the Work list is a full-height page with no column mode", () => {
		const list = src("../components/work-view.tsx");
		assert.match(list, /h-dvh/);
		assert.ok(!/column=|colWidth|WORK_EXPANDED_KEY|publishPane|yieldEsc/.test(list));
	});
});

describe("decoupling", () => {
	it("the graph knows nothing of the Work list", () => {
		const g = src("../components/graph-view.tsx");
		for (const bad of ["useWorkView", "WorkButton", "publishPane", "publishRoute", "yieldEsc", "colWidth", "splitWidth", "workSel"]) assert.ok(!g.includes(bad), bad);
		const entry = src("../components/entry-reader.tsx");
		assert.ok(!entry.includes("useWorkView") && !entry.includes("left:"));
	});
	it("no Work provider or layer state is left", () => {
		assert.ok(!existsSync(new URL("../components/work-view-entry.tsx", import.meta.url)) || !src("../components/work-view-entry.tsx").includes("WorkViewContext"));
		assert.ok(!/WORK_EXPANDED_KEY|work-view-col-width/.test(src("../components/work-view.tsx") + src("../src/core/work-select.ts")));
	});
});

describe("a graph node click", () => {
	it("opens the reader for a work node, selects a KB entry, and expands a collapsed feature", () => {
		assert.deepEqual(nodeClickAction("work:t1", new Set()), { kind: "open-work", id: "t1" });
		assert.deepEqual(nodeClickAction("ent:x", new Set()), { kind: "select" });
		assert.deepEqual(nodeClickAction("work:f1", new Set(["f1"])), { kind: "expand", id: "f1" });
	});
});

describe("sidebar", () => {
	it("has two plain links: Graph to / and Work to /work", () => {
		const bar = src("../components/sidebar.tsx");
		assert.match(bar, /href="\/"[\s\S]{0,120}data-testid="nav-graph"/);
		assert.match(bar, /<WorkNavEntry \/>/);
		const nav = src("../components/work-view-entry.tsx");
		assert.match(nav, /href="\/work"/);
		assert.match(nav, /data-testid="nav-work"/);
		assert.equal(typeof WorkNavEntry, "function");
	});
});

describe("deep links", () => {
	it("/kb/work/<id> still renders the full WorkItemPage", () => {
		assert.match(src("../app/kb/work/[id]/page.tsx"), /<WorkItemPage id=\{decodeURIComponent\(id\)\} \/>/);
		const html = renderToStaticMarkup(<WorkItemView id="f1" state={{ kind: "loading" }} />);
		assert.ok(html.includes('data-testid="work-item-page"') && html.includes("h-dvh") && !html.includes("work-reader-close"));
	});
	it("/kb/entry/<id> still renders over the graph; / and /work both mount the reader host", () => {
		assert.match(src("../app/(home)/kb/entry/[id]/page.tsx"), /EntryReaderOverlay/);
		assert.match(src("../app/(home)/page.tsx"), /WorkReaderHost/);
		assert.match(src("../app/work/page.tsx"), /WorkReaderHost/);
	});
});
