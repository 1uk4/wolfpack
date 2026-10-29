/**
 * Layering of graph / Work list / entry reader (node test runner, linkedom). The graph is always mounted (the (home)
 * layout); the Work list and the reader are overlays on it. Open Work → select a row → open the entry → close the
 * reader: the Work list stays a column over the graph (never full screen) and the graph never remounts; close the
 * Work list: the graph is alone. Esc removes one layer at a time, the reader first.
 */
import React, { act, useEffect, useState } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	fetch: async () => {
		throw new Error("offline");
	},
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
});
Object.defineProperty(dom.window, "innerWidth", { value: 1400, configurable: true });

const { WorkViewProvider } = await import("../components/work-view.tsx");
const { WorkButton, useWorkView } = await import("../components/work-view-entry.tsx");
const { EntryReaderOverlay } = await import("../components/entry-reader.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
import type { WorkClient } from "../components/work-client.ts";

const client: WorkClient = {
	domains: async () => [{ name: "wolfpack", label: "Wolfpack" }],
	list: async () => ({ ok: true, data: { items: [{ id: "t1", title: "T1", kind: "task", stage: "plan", domain: "wolfpack", dependsOn: [] }] } }),
};

let graphMounts = 0;
let graphSelected: string[] = [];
/** Stands in for graph-view: a Work row request selects here; a background click clears only the graph's own selection. */
function FakeGraph() {
	useEffect(() => void graphMounts++, []);
	const work = useWorkView();
	const [selected, setSelected] = useState<string | null>(null);
	const seq = work.selection?.seq;
	const id = work.selection?.id ?? null;
	useEffect(() => {
		if (id) {
			graphSelected.push(id);
			setSelected(id);
		}
	}, [seq, id]);
	const { publishPane } = work;
	useEffect(() => {
		publishPane(selected !== null);
		return () => publishPane(false);
	}, [selected, publishPane]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			setSelected(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);
	return (
		<div data-testid="fake-graph" data-selected={selected ?? ""}>
			<button data-testid="graph-bg" onClick={() => setSelected(null)} />
		</div>
	);
}
/** The (home) layout: the graph always, the route's page (the reader) over it. */
let go: (href: string) => void = () => {};
function Home() {
	const [href, setHref] = useState("/");
	go = setHref;
	const m = /^\/kb\/entry\/(.+)$/.exec(href);
	return (
		<AppRouterContext.Provider value={{ push: (h: string) => setHref(h) } as never}>
			<PathnameContext.Provider value={href}>
				<FakeGraph />
				{m && <EntryReaderOverlay id={decodeURIComponent(m[1]!)} />}
				<WorkButton />
				<Selector />
			</PathnameContext.Provider>
		</AppRouterContext.Provider>
	);
}
function Selector() {
	const w = useWorkView();
	return <button data-testid="sel" onClick={() => w.select("t1")} />;
}

let root: Root | null = null;
beforeEach(() => {
	store.clear();
	graphMounts = 0;
	graphSelected = [];
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const click = (el: Element) => act(async () => { el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 })); });
const esc = () =>
	act(async () => {
		const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(ev, "key", { value: "Escape" });
		// Like a browser: window capture first; the document only hears it if nobody claimed it.
		window.dispatchEvent(ev);
		if (!ev.defaultPrevented) document.dispatchEvent(ev);
	});
const mount = async () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<WorkViewProvider client={client}>
				<Home />
			</WorkViewProvider>,
		);
	});
	await settle();
};
const isColumn = () => q("work-view")!.getAttribute("aria-modal") === "false";

const openAll = async () => {
	await mount();
	await click(q("work-open")!);
	await settle();
	await click(q("sel")!); // a row selected: graph pane open
	await act(async () => go("/kb/entry/e1"));
};

describe("graph / Work / reader layering", () => {
	it("the Work list is a column as soon as it opens; the reader sits beside it", async () => {
		await mount();
		await click(q("work-open")!);
		await settle();
		assert.ok(isColumn(), "no selection needed");
		await act(async () => go("/kb/entry/e1"));
		assert.equal(Number.parseInt(q("entry-reader")!.style.left, 10), Number.parseInt(q("work-view")!.style.width, 10));
	});
	it("a row select focuses the graph node", async () => {
		await mount();
		await click(q("work-open")!);
		await settle();
		await click(q("sel")!);
		assert.deepEqual(graphSelected, ["t1"]);
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "t1");
	});
	it("a graph background click with all three open leaves the list a column and the reader open", async () => {
		await openAll();
		assert.ok(q("entry-reader") && q("work-view") && q("fake-graph"), "all three layers");
		await click(q("graph-bg")!);
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "", "graph deselected");
		assert.ok(isColumn(), "Work list still a column");
		assert.ok(q("entry-reader"), "reader still open");
		assert.equal(Number.parseInt(q("entry-reader")!.style.left, 10), Number.parseInt(q("work-view")!.style.width, 10));
	});
	it("reader closes alone, then one X closes the list; the graph never remounts", async () => {
		await openAll();
		await click(q("entry-reader-close")!);
		assert.equal(q("entry-reader"), null);
		assert.ok(q("work-view") && isColumn());
		assert.equal(graphMounts, 1);
		await click(q("work-close")!); // one X: the list is gone
		assert.equal(q("work-view"), null);
		assert.ok(q("fake-graph"));
		assert.equal(graphMounts, 1);
	});
	it("Esc order: reader, then the graph pane, then the Work list", async () => {
		await openAll();
		await esc();
		assert.equal(q("entry-reader"), null);
		assert.ok(q("work-view") && q("fake-graph")!.getAttribute("data-selected") === "t1");
		await esc();
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "", "pane closed");
		assert.ok(q("work-view") && isColumn());
		await esc();
		assert.equal(q("work-view"), null);
		assert.ok(q("fake-graph"));
	});
	it("expanded list: the reader opens at the left edge; collapse puts it beside the column again", async () => {
		await mount();
		await click(q("work-open")!);
		await settle();
		await click(q("work-layout-toggle")!);
		await act(async () => go("/kb/entry/e1"));
		assert.equal(Number.parseInt(q("entry-reader")!.style.left, 10) || 0, 0);
		await click(q("work-layout-toggle")!);
		assert.ok(Number.parseInt(q("entry-reader")!.style.left, 10) > 0);
	});
	it("the reader alone (graph node click / palette path) leaves just graph + reader", async () => {
		await mount();
		await act(async () => go("/kb/entry/e1"));
		assert.ok(q("fake-graph") && q("entry-reader") && !q("work-view"));
		assert.equal(Number.parseInt(q("entry-reader")!.style.left, 10) || 0, 0);
		await click(q("entry-reader-close")!);
		assert.ok(q("fake-graph") && !q("entry-reader"));
	});
});
