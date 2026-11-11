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
(globalThis as Record<string, unknown>).self ??= globalThis; // next/link touches `self` (requestIdleCallback) when it mounts
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

// linkedom has no focus model: track it so the reader's focus-on-open can be asserted.
let focused: Element | null = null;
(dom.window.Element.prototype as unknown as { focus: () => void }).focus = function (this: Element) {
	focused = this;
};
Object.defineProperty(dom.document, "activeElement", { get: () => focused ?? dom.document.body, configurable: true });

const { FakeNav, navLog, currentUrl, historyBack, historyForward } = await import("./helpers/fake-nav.tsx");
const { WorkReaderPanel, readerUrl, useWorkReader } = await import("../components/work-reader.tsx");
const { useOpenWorkItem, openReaderLink, settleReaderOpen, isPlainClick, shouldOpenInReader } = await import("../components/work-reader-nav.ts");
const { WorkReaderHost } = await import("../components/work-reader.tsx");
const { PlanGraphCard } = await import("../components/plan-graph-card.tsx");
const { nodeClickAction } = await import("../components/graph/graph-view.tsx");
const { NavTracker, hasInAppHistory } = await import("../components/nav-tracker.tsx");
const { WorkNavEntry } = await import("../components/work-nav-link.tsx");
const { WorkItemView } = await import("../components/work-item-page.tsx");
const { EntryReaderView, shouldGoBackOnEscape } = await import("../components/entry-reader.tsx");

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

describe("isPlainClick", () => {
	const ev = (o: Record<string, unknown> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...o });
	it("is true only for an unmodified primary click nobody else handled", () => {
		assert.equal(isPlainClick(ev()), true);
		for (const o of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) assert.equal(isPlainClick(ev(o)), false, JSON.stringify(o));
	});
});

describe("shouldOpenInReader", () => {
	const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
	it("table: an in-place link takes over only a plain click on a link that has a work id", () => {
		const rows: [string, Record<string, unknown>, string | null | undefined, boolean][] = [
			["plain click, id", {}, "w1", true],
			["no id", {}, undefined, false],
			["null id", {}, null, false],
			["empty id", {}, "", false],
			["cmd", { metaKey: true }, "w1", false],
			["ctrl", { ctrlKey: true }, "w1", false],
			["shift", { shiftKey: true }, "w1", false],
			["alt", { altKey: true }, "w1", false],
			["middle button", { button: 1 }, "w1", false],
			["already handled", { defaultPrevented: true }, "w1", false],
		];
		for (const [name, o, id, want] of rows) assert.equal(shouldOpenInReader({ ...plain, ...o }, id), want, name);
	});
});

describe("focus return", () => {
	it("closing the reader gives focus back to the element that had it; a detached opener is skipped", async () => {
		const opener = document.createElement("button");
		document.body.appendChild(opener);
		focused = opener;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/work"><WorkReaderPanel id="f1" onClose={() => {}} /></FakeNav>));
		assert.ok(focused !== opener, "reader took focus");
		await act(async () => root!.unmount());
		root = null;
		assert.ok(focused === opener, "focus returned to the opener");
		const gone = document.createElement("button");
		focused = gone; // never attached
		const host2 = document.createElement("div");
		document.body.appendChild(host2);
		root = createRoot(host2);
		await act(async () => root!.render(<FakeNav start="/work"><WorkReaderPanel id="f1" onClose={() => {}} /></FakeNav>));
		const readerFocus = focused;
		await act(async () => root!.unmount());
		root = null;
		assert.ok(focused === readerFocus, "a detached opener is left alone");
	});
});

describe("focus", () => {
	it("the reader takes focus when it opens: the close button", async () => {
		focused = null;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/work"><WorkReaderPanel id="f1" onClose={() => {}} /></FakeNav>));
		// Booleans, not the nodes: a failing assert.equal on two DOM nodes tries to diff the whole tree and hangs.
		assert.ok(focused === document.querySelector('[data-testid="work-reader-close"]'), "the close button has focus after open");
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

describe("Esc order", () => {
	const esc = (target: EventTarget = window) => {
		const e = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(e, "key", { value: "Escape" });
		target.dispatchEvent(e);
		return e;
	};
	const mountPanel = async (onClose: () => void) => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/work"><WorkReaderPanel id="f1" onClose={onClose} /></FakeNav>));
	};
	const overlay = (attrs: Record<string, string>) => {
		const el = document.createElement("div");
		for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
		document.body.appendChild(el);
		return el;
	};
	it("leaves Esc to the id hover card (a portaled dialog) while it is open, then closes the reader", async () => {
		let closed = 0;
		await mountPanel(() => closed++);
		const card = overlay({ role: "dialog", "data-testid": "work-card" });
		await act(async () => void esc());
		assert.equal(closed, 0);
		card.remove();
		await act(async () => void esc());
		assert.equal(closed, 1);
	});
	it("leaves Esc to the REAL id hover card (a role=dialog portal) and ignores hidden or closed overlays", async () => {
		const { WorkIdChip } = await import("../components/work-id-chip.tsx");
		let closed = 0;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/work"><WorkReaderPanel id="f1" onClose={() => closed++} /><WorkIdChip id="work-wolfpack-cEg92qS" /></FakeNav>));
		await act(async () => void (document.querySelector("[data-work-id]") as HTMLElement).dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
		const card = document.querySelector('[data-testid="work-card"]');
		assert.equal(card?.getAttribute("role"), "dialog");
		await act(async () => void esc());
		assert.equal(closed, 0, "the open hover card owns Esc");
		// closed/hidden overlays do not block
		card!.setAttribute("hidden", "");
		overlay({ role: "listbox", "aria-hidden": "true" });
		overlay({ role: "dialog", style: "display: none" });
		await act(async () => void esc());
		assert.equal(closed, 1);
	});
	it("leaves Esc to the chat bar's thread switcher while it is open", async () => {
		let closed = 0;
		await mountPanel(() => closed++);
		const sw = overlay({ role: "dialog", "data-testid": "chat-bar-switcher" });
		await act(async () => void esc(sw));
		assert.equal(closed, 0);
	});
	it("closes the reader on Esc typed in the bar composer, which has no Esc of its own", async () => {
		let closed = 0;
		await mountPanel(() => closed++);
		const bar = overlay({ "data-testid": "chat-bar" });
		const input = document.createElement("textarea");
		bar.appendChild(input);
		await act(async () => void esc(input));
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
		assert.ok(html.includes("h-dvh") && !html.includes('role="dialog"') && !html.includes("aria-modal") && !html.includes("entry-reader-close"));
		assert.ok(html.includes('href="/?focus=ent%3Aw%2Fx"') && html.includes("entry-open-in-graph"));
	});
	it("Open in graph has a phone-size tap target", () => {
		const html = renderToStaticMarkup(<EntryReaderView id="x" state={{ kind: "loading" }} />);
		assert.ok(html.includes("max-md:min-h-11") && html.includes("max-md:min-w-11"));
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
		const g = src("../components/graph/graph-view.tsx");
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
		const g = src("../components/graph/graph-view.tsx");
		const handler = g.slice(g.indexOf("onSelect: (nodeId)"), g.indexOf("onStageClick"));
		assert.match(handler, /openWorkRef\.current\(act\.id\)/);
		assert.ok(!/setExpanded|expanded/.test(g), "the expand-in-place state is gone");
		assert.ok(!g.includes("collapsedRef") && !g.includes("onNodeDoubleClick") && !g.includes("FeatureTaskOverlay"));
		// setSelected sits only on the non-work branch
		assert.match(handler, /else setSelected\(\{ id: nodeId \}\)/);
	});
});

describe("sidebar", () => {
	it("has two plain links: Graph to /graph and Work to /work", () => {
		const bar = src("../components/sidebar.tsx");
		assert.match(bar, /href="\/graph"[\s\S]{0,120}data-testid="nav-graph"/);
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
	});

	it("exactly one WorkReaderHost is mounted, in the shell every page (threads included) renders under", () => {
		const mounts = ["../components/sidebar.tsx", "../app/page.tsx", "../app/graph/page.tsx", "../app/work/page.tsx", "../app/layout.tsx"].filter((f) => /<WorkReaderHost\b/.test(src(f)));
		assert.deepEqual(mounts, ["../components/sidebar.tsx"]);
	});
});

describe("opening a work item from any page", () => {
	const realLocation = Object.getOwnPropertyDescriptor(window, "location");
	afterEach(() => {
		if (realLocation) Object.defineProperty(window, "location", realLocation);
		else delete (window as unknown as Record<string, unknown>).location;
	});
	const useLocation = () =>
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { get pathname() { return currentUrl().split("?")[0]; }, get search() { return currentUrl().split("?")[1] ? `?${currentUrl().split("?")[1]}` : ""; }, assign: () => {} },
		});
	function Opener() {
		const open = useOpenWorkItem();
		return <button data-testid="go" onClick={() => open("wk1")} />;
	}
	it("from a wolf thread page keeps the path and its params and adds ?item=; a second open replaces instead of stacking", async () => {
		useLocation();
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/wolf/hal/thread/t1?x=1"><Opener /></FakeNav>));
		await act(async () => (document.querySelector('[data-testid="go"]') as HTMLElement).click());
		assert.equal(currentUrl(), "/wolf/hal/thread/t1?x=1&item=wk1");
		assert.equal(navLog.stack.length, 2);
		await act(async () => (document.querySelector('[data-testid="go"]') as HTMLElement).click());
		assert.equal(navLog.stack.length, 2, "switching items does not add a history entry");
	});

	it("a second open before the router has updated window.location replaces instead of stacking a second entry", async () => {
		settleReaderOpen();
		const committed = "/wolf/hal/thread/t1"; // window.location lags: it still shows the page without ?item=
		Object.defineProperty(window, "location", { configurable: true, value: { pathname: committed, search: "", assign: () => {} } });
		function Two() {
			const open = useOpenWorkItem();
			return <><button data-testid="a" onClick={() => open("wk1")} /><button data-testid="b" onClick={() => open("wk2")} /></>;
		}
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start={committed}><Two /></FakeNav>));
		await act(async () => {
			(document.querySelector('[data-testid="a"]') as HTMLElement).click();
			(document.querySelector('[data-testid="b"]') as HTMLElement).click();
		});
		assert.equal(navLog.stack.length, 2, "one pushed entry, not two");
		assert.equal(currentUrl(), "/wolf/hal/thread/t1?item=wk2");
		settleReaderOpen();
	});

	it("the host opens the reader for ?item= on a wolf thread page", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/wolf/hal/thread/t1?item=wk1"><WorkReaderHost /></FakeNav>));
		assert.equal(document.querySelector('[data-testid="work-reader"]')?.getAttribute("data-work"), "wk1");
	});

	it("openReaderLink leaves modified and non-primary clicks to the browser", () => {
		const click = (o: object) => {
			let prevented = false;
			const opened: string[] = [];
			openReaderLink({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => (prevented = true), ...o }, (i) => opened.push(i), "x");
			return { prevented, opened };
		};
		assert.deepEqual(click({}), { prevented: true, opened: ["x"] });
		for (const o of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) assert.deepEqual(click(o), { prevented: false, opened: [] }, JSON.stringify(o));
	});

	it("a graph node click opens the work item in the reader on the current page", async () => {
		settleReaderOpen();
		useLocation();
		const data = { nodes: [{ id: "work-wolfpack-ASNQgEf", label: "A work item", kind: "task", status: "doing" }], edges: [] };
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(
			<FakeNav start="/wolf/hal/thread/t1">
				<PlanGraphCard objectId="o" type="graph" rev={1} data={data} />
			</FakeNav>,
		));
		const hit = document.querySelector('[data-node-id="work-wolfpack-ASNQgEf"] [data-testid="graph-node-hit"]') as HTMLElement;
		await act(async () => void hit.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
		assert.equal(currentUrl(), "/wolf/hal/thread/t1?item=work-wolfpack-ASNQgEf");
		settleReaderOpen();
	});

	it("the reader's PART OF and DEPENDS ON links switch the item in place instead of navigating", async () => {
		const opened: string[] = [];
		const item = { id: "f1", title: "T", kind: "task", stage: "plan", domain: "d", partOf: "parent1", dependsOn: ["dep1"], plan: "p", record: "r", children: [] } as never;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<FakeNav start="/work?item=f1"><WorkItemView id="f1" state={{ kind: "ready", item, parent: null }} onOpenTask={(i) => opened.push(i)} onClose={() => {}} /></FakeNav>));
		for (const href of ["/kb/work/parent1", "/kb/work/dep1"]) {
			const a = document.querySelector(`a[href="${href}"]`) as HTMLElement;
			const ev = new dom.window.Event("click", { bubbles: true, cancelable: true }); Object.assign(ev, { button: 0 });
			await act(async () => { a.dispatchEvent(ev); });
			assert.equal(ev.defaultPrevented, true);
		}
		assert.deepEqual(opened, ["parent1", "dep1"]);
		assert.ok(document.querySelector('[data-testid="work-reader-full"]')?.getAttribute("href") === "/kb/work/f1", "the full page stays reachable");
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

describe("entry page Esc", () => {
	const none = { querySelector: () => null };
	const ev = (o: Record<string, unknown> = {}) => ({ key: "Escape", defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, target: null, ...o }) as never;
	const el = (tagName: string, editable = false) => ({ tagName, closest: (sel: string) => (editable && sel === "[contenteditable]" ? {} : null) });
	it("plain Esc goes back", () => assert.equal(shouldGoBackOnEscape(ev(), none, false), true));
	it("other keys, defaultPrevented, IME composition and modifiers are ignored", () => {
		assert.equal(shouldGoBackOnEscape(ev({ key: "a" }), none, false), false);
		assert.equal(shouldGoBackOnEscape(ev({ defaultPrevented: true }), none, false), false);
		assert.equal(shouldGoBackOnEscape(ev({ isComposing: true }), none, false), false);
		for (const m of ["metaKey", "ctrlKey", "altKey"]) assert.equal(shouldGoBackOnEscape(ev({ [m]: true }), none, false), false, m);
	});
	it("editable targets (input, textarea, contenteditable descendant) keep their Esc", () => {
		assert.equal(shouldGoBackOnEscape(ev({ target: el("INPUT") }), none, false), false);
		assert.equal(shouldGoBackOnEscape(ev({ target: el("TEXTAREA") }), none, false), false);
		assert.equal(shouldGoBackOnEscape(ev({ target: el("SPAN", true) }), none, false), false);
		assert.equal(shouldGoBackOnEscape(ev({ target: el("DIV") }), none, false), true);
	});
	it("an open dialog or active dictation owns the Esc", () => {
		assert.equal(shouldGoBackOnEscape(ev(), { querySelector: () => ({}) }, false), false);
		assert.equal(shouldGoBackOnEscape(ev(), none, true), false);
	});
	it("back vs home: hasInAppHistory is false on a deep link", () => {
		assert.equal(hasInAppHistory(), false);
		assert.match(src("../components/entry-reader.tsx"), /hasInAppHistory\(\)\) router\.back\(\);\s*else router\.push\("\/"\)/);
	});
});
