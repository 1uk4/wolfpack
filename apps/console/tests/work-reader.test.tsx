/**
 * The split of the Work list and the Graph: the reader panel (URL-driven, full screen on phones), the graph's
 * work-node click, the two sidebar links, and the deep links that keep working. The list's own behaviour is in
 * work-view.test.tsx.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

const { FakeNav, navLog, currentUrl, historyBack, historyForward } = await import("./helpers/fake-nav.tsx");
const { WorkReaderPanel, readerUrl, useWorkReader } = await import("../components/work-reader.tsx");
const { nodeClickAction } = await import("../components/graph-view.tsx");
const { NavTracker, hasInAppHistory } = await import("../components/nav-tracker.tsx");
const { WorkNavEntry } = await import("../components/work-nav-link.tsx");
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
	it("the KB entry is a full page, not an overlay, with an Open in graph link to the focused node", () => {
		const html = renderToStaticMarkup(<EntryReaderView id="w/x" state={{ kind: "loading" }} />);
		assert.ok(html.includes("h-dvh") && !html.includes("dialog") && !html.includes("entry-reader-close"));
		assert.ok(html.includes('href="/?focus=ent%3Aw%2Fx"') && html.includes("entry-open-in-graph"));
	});
	it("the Work list is a full-height page with no column mode", () => {
		const list = src("../components/work-view.tsx");
		assert.match(list, /h-dvh/);
		assert.ok(!/column=|colWidth|WORK_EXPANDED_KEY|publishPane|yieldEsc/.test(list));
	});
});


// ---- behaviour: useWorkReader through FakeNav ------------------------------------------------------------------

let api!: ReturnType<typeof useWorkReader>;
function Probe() {
	api = useWorkReader();
	return <span data-testid="probe">{api.itemId ?? ""}</span>;
}
const mountProbe = async (start: string, extra: React.ReactNode = null) => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start={start}><Probe />{extra}</FakeNav>));
};
const stack = () => navLog.stack.slice();

describe("useWorkReader history", () => {
	it("open pushes ?item=; switching items replaces; close goes Back", async () => {
		await mountProbe("/work");
		await act(async () => api.open("a"));
		assert.deepEqual(stack(), ["/work", "/work?item=a"]);
		assert.equal(api.itemId, "a");
		await act(async () => api.open("b"));
		assert.deepEqual(stack(), ["/work", "/work?item=b"], "switching replaces the entry");
		await act(async () => api.close());
		assert.equal(currentUrl(), "/work");
		assert.equal(api.itemId, null);
		assert.deepEqual(stack(), ["/work", "/work?item=b"], "closing was a real Back: Forward can re-open");
	});
	it("Forward re-opens, and closing then still goes Back: no duplicate entry", async () => {
		await mountProbe("/work");
		await act(async () => api.open("a"));
		await act(async () => historyBack());
		await act(async () => historyForward());
		assert.equal(api.itemId, "a");
		await act(async () => api.close());
		assert.equal(currentUrl(), "/work");
		assert.deepEqual(stack(), ["/work", "/work?item=a"], "no [A, A]");
		assert.equal(navLog.index, 0);
	});
	it("a deep link closes with replace (nothing to go Back to inside the console)", async () => {
		await mountProbe("/work?item=zz");
		assert.equal(api.itemId, "zz");
		await act(async () => api.close());
		assert.deepEqual(stack(), ["/work"]);
		assert.equal(api.itemId, null);
	});
	it("opening from a different page later is not fooled by an earlier in-app open (no stale counter)", async () => {
		await mountProbe("/work");
		await act(async () => api.open("a"));
		await act(async () => root!.unmount());
		document.body.innerHTML = "";
		await mountProbe("/?item=q"); // a fresh deep link
		await act(async () => api.close());
		assert.deepEqual(stack(), ["/"], "replaced, not Back");
	});
	it("keeps the page's other params", async () => {
		await mountProbe("/?focus=x");
		await act(async () => api.open("a"));
		assert.equal(currentUrl(), "/?focus=x&item=a");
		await act(async () => api.close());
		assert.equal(currentUrl(), "/?focus=x");
	});
});

describe("Esc and dialogs above the reader", () => {
	const esc = (target: EventTarget = window) =>
		act(async () => {
			const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(ev, "key", { value: "Escape" });
			target.dispatchEvent(ev);
		});
	it("a dialog open above the reader (e.g. the graduate dialog) keeps its own Esc; the reader stays", async () => {
		let closed = 0;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/work"><WorkReaderPanel id="f1" onClose={() => closed++} /></FakeNav>));
		const dlg = document.createElement("div");
		dlg.setAttribute("role", "dialog");
		dlg.setAttribute("aria-modal", "true");
		document.body.appendChild(dlg);
		await esc();
		assert.equal(closed, 0, "the dialog owns this Esc");
		dlg.remove();
		await esc();
		assert.equal(closed, 1);
	});
	it("an Esc another layer already claimed (defaultPrevented) is left alone", async () => {
		let closed = 0;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/work"><WorkReaderPanel id="f1" onClose={() => closed++} /></FakeNav>));
		await act(async () => {
			const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(ev, "key", { value: "Escape" });
			ev.preventDefault();
			window.dispatchEvent(ev);
		});
		assert.equal(closed, 0);
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
		assert.ok(!src("../components/work-nav-link.tsx").includes("WorkViewContext"));
		assert.ok(!/WORK_EXPANDED_KEY|work-view-col-width/.test(src("../components/work-view.tsx") + src("../src/core/work-select.ts")));
	});
});

describe("a graph node click: the reader only", () => {
	it("any work node, a collapsed feature included, opens the reader; KB entries still select", () => {
		for (const id of ["work:t1", "work:f1", "work:i1"]) assert.deepEqual(nodeClickAction(id), { kind: "open-work", id: id.slice(5) });
		assert.deepEqual(nodeClickAction("ent:x"), { kind: "select" });
		assert.deepEqual(nodeClickAction("fac:d"), { kind: "select" });
	});
	it("the click handler neither expands collapsed features nor selects for a work node; no double-click overlay competes", () => {
		const g = src("../components/graph-view.tsx");
		const handler = g.slice(g.indexOf("onSelect: (nodeId)"), g.indexOf("onStageClick"));
		assert.match(handler, /openWorkRef\.current\(act\.id\)/);
		assert.ok(!/setExpanded|expanded/.test(g), "the expand-in-place state is gone");
		assert.ok(!g.includes("collapsedRef") && !g.includes("onNodeDoubleClick") && !g.includes("FeatureTaskOverlay"));
		// setSelected sits only on the non-work branch
		assert.match(handler, /else setSelected\(\{ id: nodeId \}\)/);
	});
});

describe("sidebar", () => {
	it("has two plain links: Graph to / and Work to /work", () => {
		const bar = src("../components/sidebar.tsx");
		assert.match(bar, /href="\/"[\s\S]{0,120}data-testid="nav-graph"/);
		assert.match(bar, /<WorkNavEntry \/>/);
		const nav = src("../components/work-nav-link.tsx");
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
	it("/kb/entry/<id> is a standalone page outside the (home) graph layout; / and /work both mount the reader host", () => {
		assert.match(src("../app/kb/entry/[id]/page.tsx"), /EntryReaderPage/);
		assert.ok(!existsSync(new URL("../app/(home)/kb/entry", import.meta.url)));
		assert.match(src("../app/(home)/page.tsx"), /WorkReaderHost/);
		assert.match(src("../app/work/page.tsx"), /WorkReaderHost/);
	});
});

describe("NavTracker", () => {
	it("a mount (and a strict-mode re-run) is not a navigation; only a real pathname change counts", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<React.StrictMode><FakeNav start="/kb/entry/x"><NavTracker /><Probe /></FakeNav></React.StrictMode>));
		assert.equal(hasInAppHistory(), false, "a deep link must not look like in-app history");
		await act(async () => api.open("a")); // same pathname, only ?item= changes
		assert.equal(hasInAppHistory(), false);
	});
});
