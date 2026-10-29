/**
 * The Work view's split (node test runner, linkedom): selecting a row splits the view into a left column and asks the
 * graph to select; route rows carry the step numbers of the SAME computeWorkRoute result (a stand-in graph runs the
 * real routeForNode / cursor code and publishes through the context, as graph-view does); off-route rows dim; a
 * collapsed done feature is one "+N" row; the pane cursor syncs to a row highlight; Esc / close restore; the column
 * width resizes and persists; the sidebar entry opens the graph page.
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
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
});
Object.defineProperty(dom.window, "innerWidth", { value: 1400, configurable: true });

const { WorkViewProvider, WORK_EXPANDED_KEY } = await import("../components/work-view.tsx");
const { WorkButton, WorkNavEntry, useWorkView } = await import("../components/work-view-entry.tsx");
const { routeForNode, rawWorkId, reconcileCursor } = await import("../src/core/dep-route-adapter.ts");
const { cursorNext, cursorPrev } = await import("../src/core/work-route.ts");
const { workRouteView, WORK_COL_WIDTH_KEY } = await import("../src/core/work-select.ts");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
import type { WorkClient } from "../components/work-client.ts";
import type { KbGraph, WorkListItem } from "../src/core/kb.ts";
import type { RouteCursor } from "../src/core/work-route.ts";

const item = (id: string, kind: string, over: Partial<WorkListItem> = {}): WorkListItem => ({ id, title: id.toUpperCase(), kind, stage: "plan", domain: "wolfpack", dependsOn: [], ...over });
// F1: a(shipped) -> b, c (parallel) -> e;  F1 dependsOn FD (shipped, two shipped tasks: collapses);  FX is unrelated.
const ITEMS: WorkListItem[] = [
	item("i1", "initiative"),
	item("f1", "feature", { partOf: "i1", stage: "in_build", dependsOn: ["fd"] }),
	item("a", "task", { partOf: "f1", stage: "shipped" }),
	item("b", "task", { partOf: "f1", stage: "in_build", dependsOn: ["a"] }),
	item("c", "task", { partOf: "f1", stage: "plan", dependsOn: ["a"] }),
	item("e", "task", { partOf: "f1", stage: "plan", dependsOn: ["b", "c"] }),
	item("fd", "feature", { partOf: "i1", stage: "shipped" }),
	item("d1", "task", { partOf: "fd", stage: "shipped" }),
	item("d2", "task", { partOf: "fd", stage: "shipped" }),
	item("fx", "feature", { partOf: "i1", stage: "plan" }),
];
const graph: KbGraph = {
	nodes: ITEMS.map((i) => ({ id: `work:${i.id}`, kind: "work" as const, label: i.title, depth: 3, domain: "wolfpack", workKind: i.kind, stage: i.stage })),
	edges: ITEMS.flatMap((i) => [
		...(i.partOf ? [{ source: `work:${i.id}`, target: `work:${i.partOf}`, kind: "partOf" as const }] : []),
		...i.dependsOn.map((d) => ({ source: `work:${i.id}`, target: `work:${d}`, kind: "dependsOn" as const })),
	]),
	layers: { archivedWork: false, denTopics: false },
	domain: null,
	domains: [],
	generated: "2026-10-28T00:00:00.000Z",
};

const client = (): WorkClient => ({
	domains: async () => [{ name: "wolfpack", label: "Wolfpack" }],
	list: async () => ({ ok: true, data: { items: ITEMS } }),
});

/** Stands in for graph-view: the same selection request → real route → published view, plus the pane's ←/→ cursor. */
let graphSelected: string[] = [];
let setCursorExt: ((dir: 1 | -1) => void) | null = null;
let expandExt: ((feature: string) => void) | null = null;
function FakeGraph() {
	const work = useWorkView();
	const [selected, setSelected] = useState<string | null>(null);
	const [cursor, setCursor] = useState<RouteCursor | null>(null);
	const seq = work.selection?.seq;
	const id = work.selection?.id ?? null;
	useEffect(() => {
		if (id) {
			graphSelected.push(`work:${id}`);
			setSelected(id);
			setCursor(null);
		}
	}, [seq, id]);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	expandExt = (f) => setExpanded(new Set([f]));
	const route = selected ? routeForNode(graph, `work:${selected}`, { expanded }) : null;
	const eff = route ? reconcileCursor(route, cursor) : null;
	setCursorExt = (dir) => route && eff && setCursor(dir === 1 ? cursorNext(route, eff) : cursorPrev(route, eff));
	const { publishRoute, publishPane } = work;
	useEffect(() => {
		publishPane(selected !== null);
		return () => publishPane(false);
	}, [selected, publishPane]);
	// Like the real pane: Esc closes it unless a higher layer already claimed the key.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			setSelected(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);
	useEffect(() => {
		publishRoute(selected ? workRouteView(route, selected, eff?.node ?? null) : null);
	}, [selected, cursor, expanded]); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<div data-testid="fake-graph" data-selected={selected ?? ""}>
			<button data-testid="graph-bg" onClick={() => setSelected(null)} />
		</div>
	);
}

let root: Root | null = null;
let pushed: string[] = [];
beforeEach(() => {
	store.clear();
	graphSelected = [];
	pushed = [];
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const mount = async (pathname = "/") => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push: (h: string) => void pushed.push(h) } as never}>
				<PathnameContext.Provider value={pathname}>
					<WorkViewProvider client={client()}>
						<FakeGraph />
						<WorkButton />
						<WorkNavEntry />
					</WorkViewProvider>
				</PathnameContext.Provider>
			</AppRouterContext.Provider>,
		);
	});
};
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = (el: Element) => act(async () => { el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 })); });
const key = (k: string, target: Element | Document = document) =>
	act(async () => {
		const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(ev, "key", { value: k });
		target.dispatchEvent(ev);
	});
const pointer = (type: string, clientX: number, target: EventTarget = window as unknown as EventTarget) =>
	act(async () => {
		const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
		Object.defineProperty(ev, "clientX", { value: clientX });
		target.dispatchEvent(ev);
	});
/** Open the view, expand i1 and f1, select task `e` (route: a → b ∥ c → e, fd collapsed). */
const openAndSelect = async (id = "e") => {
	await mount();
	await click(q("work-open")!);
	await settle();
	await click(q("work-toggle-i1")!);
	await click(q("work-toggle-f1")!);
	await click(q(`work-row-${id}`)!);
	await settle();
};
const step = (id: string) => q(`work-row-${id}`)?.getAttribute("data-step") ?? null;

describe("layout", () => {
	it("opens as a column over the graph by default, no selection needed", async () => {
		await mount();
		await click(q("work-open")!);
		await settle();
		assert.ok(q("work-resize"), "a column with a resize edge");
		assert.equal(q("work-view")!.getAttribute("aria-modal"), "false");
		assert.ok(Number.parseInt(q("work-view")!.style.width, 10) > 0);
	});
	it("selecting a row selects it on the graph and keeps the column", async () => {
		await mount();
		await click(q("work-open")!);
		await settle();
		await click(q("work-toggle-i1")!);
		await click(q("work-row-fx")!);
		assert.ok(q("work-resize"));
		assert.deepEqual(graphSelected, ["work:fx"]);
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "fx");
	});
	it("re-selecting another row re-selects on the graph", async () => {
		await openAndSelect("e");
		await click(q("work-row-b")!);
		assert.deepEqual(graphSelected, ["work:e", "work:b"]);
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "b");
	});
	it("the toggle expands to the full-screen table and collapses back, and the choice is remembered", async () => {
		await mount();
		await click(q("work-open")!);
		await settle();
		await click(q("work-layout-toggle")!);
		assert.ok(q("work-view") && !q("work-resize"));
		assert.equal(q("work-view")!.getAttribute("aria-modal"), "true");
		assert.equal(store.get(WORK_EXPANDED_KEY), "1");
		// close and reopen: still expanded (and a fresh mount reads it too)
		await click(q("work-close")!);
		await click(q("work-open")!);
		await settle();
		assert.ok(!q("work-resize"), "reopens expanded");
		await click(q("work-layout-toggle")!);
		assert.ok(q("work-resize"));
		assert.equal(store.get(WORK_EXPANDED_KEY), "0");
		await click(q("work-layout-toggle")!);
		act(() => root?.unmount());
		document.body.innerHTML = "";
		await mount();
		await click(q("work-open")!);
		await settle();
		assert.ok(!q("work-resize"), "a new session starts expanded");
	});
	it("selecting a row in the expanded table collapses to the column so the graph shows the node", async () => {
		store.set(WORK_EXPANDED_KEY, "1");
		await mount();
		await click(q("work-open")!);
		await settle();
		await click(q("work-toggle-i1")!);
		assert.ok(!q("work-resize"));
		await click(q("work-row-fx")!);
		assert.ok(q("work-resize"), "column now");
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "fx");
	});
});

describe("graph is independent", () => {
	it("a graph background click does not collapse or close the Work list", async () => {
		await openAndSelect("e");
		await click(q("graph-bg")!);
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "");
		assert.ok(q("work-view") && q("work-resize"), "still the column");
		assert.ok(q("work-row-e"), "rows still there");
	});
	it("with the list expanded, graph clicks leave it expanded", async () => {
		await mount();
		await click(q("work-open")!);
		await settle();
		await click(q("work-layout-toggle")!);
		await click(q("graph-bg")!);
		assert.ok(q("work-view") && !q("work-resize"));
	});
});

describe("route rows", () => {
	it("carry step numbers from the route; parallel steps share one", async () => {
		await openAndSelect("e");
		const route = routeForNode(graph, "work:e")!;
		const expected = (raw: string) => String(route.steps.find((s) => s.nodes.includes(raw))!.index + 1);
		for (const id of ["a", "b", "c", "e"]) assert.equal(step(id), expected(id), id);
		assert.equal(step("b"), step("c"));
		assert.ok(Number(step("a")) < Number(step("b")) && Number(step("b")) < Number(step("e")));
		assert.equal(q("work-step-b")!.textContent, step("b"));
		assert.equal(q("work-row-b")!.getAttribute("data-route"), "on");
	});
	it("off-route rows dim", async () => {
		await openAndSelect("e");
		assert.equal(q("work-row-fx")!.getAttribute("data-route"), "off");
		assert.match(q("work-row-fx")!.className, /opacity-35/);
		assert.equal(q("work-row-fx")!.getAttribute("data-step"), null);
		assert.ok(!/opacity-35/.test(q("work-row-b")!.className));
	});
	it("the selected row's lanes light in the route colour; lanes elsewhere stay faint or muted", async () => {
		await openAndSelect("e");
		const lanes = [...document.querySelectorAll('g[data-testid^="work-lane-"]')];
		assert.ok(lanes.length > 0, "the opened groups draw lanes");
		const lit = lanes.filter((g) => g.getAttribute("data-lane-state") === "lit");
		assert.ok(lit.length > 0, "a lane touching the route is lit");
		for (const g of lit) assert.equal(g.getAttribute("stroke"), "#ffd166");
		for (const g of lanes.filter((g) => g.getAttribute("data-lane-state") === "done")) assert.equal(g.getAttribute("stroke"), "#7d8493");
	});
	it("a collapsed done feature is one row with +N, its tasks hidden; expanding on the map opens it", async () => {
		await openAndSelect("e");
		const route = routeForNode(graph, "work:e")!;
		assert.deepEqual(Object.keys(route.collapsed), ["fd"]);
		assert.equal(q("work-collapsed-fd")!.textContent, "+2");
		assert.ok(!q("work-toggle-fd"), "no expander while collapsed");
		assert.ok(!q("work-row-d1"));
		assert.equal(q("work-row-fd")!.getAttribute("data-route"), "on");
		// the graph expands fd on the map -> the published route has no collapse -> its rows open
		await act(async () => expandExt!("fd"));
		assert.ok(!q("work-collapsed-fd"));
		assert.ok(q("work-row-d1") && q("work-row-d2"));
		assert.ok(q("work-row-d1")!.getAttribute("data-step"), "its tasks are on the route now");
	});
});

describe("cursor sync", () => {
	it("stepping the pane's cursor moves the highlight to the matching row", async () => {
		await openAndSelect("e");
		const route = routeForNode(graph, "work:e")!;
		const start = reconcileCursor(route, null);
		assert.equal(q(`work-row-${start.node}`)!.getAttribute("data-cursor"), "true");
		const next = cursorNext(route, start);
		await act(async () => setCursorExt!(1));
		assert.equal(q(`work-row-${next.node}`)!.getAttribute("data-cursor"), "true");
		assert.equal(document.querySelectorAll('[data-cursor="true"]').length, 1);
		await act(async () => setCursorExt!(-1));
		assert.equal(q(`work-row-${start.node}`)!.getAttribute("data-cursor"), "true");
	});
	it("clicking another row reselects and moves the highlight", async () => {
		await openAndSelect("e");
		await click(q("work-row-c")!);
		assert.equal(q("work-row-c")!.getAttribute("data-selected"), "true");
		assert.equal(document.querySelectorAll('[data-selected="true"]').length, 1);
	});
});

describe("closing", () => {
	it("Esc closes the graph pane first, then the Work list", async () => {
		await openAndSelect("e");
		await key("Escape");
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "", "pane closed");
		assert.ok(q("work-view") && q("work-resize"), "list still open as a column");
		await key("Escape");
		assert.equal(q("work-view"), null, "second Esc closes the list");
	});
	it("Esc with no pane closes the list at once", async () => {
		await mount();
		await click(q("work-open")!);
		await settle();
		await key("Escape");
		assert.equal(q("work-view"), null);
	});
	it("Esc while typing in the search box leaves the column alone", async () => {
		await openAndSelect("e");
		const search = q("work-search")!;
		await key("Escape", search);
		assert.ok(q("work-resize"));
	});
	it("one X closes the list entirely, graph selection untouched", async () => {
		await openAndSelect("e");
		await click(q("work-close")!);
		assert.equal(q("work-view"), null);
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "e");
	});
	it("re-selecting the same row after closing and reopening is a fresh request", async () => {
		await openAndSelect("e");
		await click(q("work-close")!);
		await click(q("graph-bg")!);
		await click(q("work-open")!);
		await settle();
		await click(q("work-toggle-i1")!);
		await click(q("work-toggle-f1")!);
		await click(q("work-row-e")!);
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "e");
	});
});

describe("column width", () => {
	it("dragging the right edge resizes (clamped like the pane) and remembers the width", async () => {
		await openAndSelect("e");
		const w0 = Number.parseInt(q("work-view")!.style.width, 10);
		// the handler is React's: call it through the props
		const handle = q("work-resize")!;
		const props = Object.keys(handle).find((k) => k.startsWith("__reactProps"))!;
		await act(async () => (handle as unknown as Record<string, { onPointerDown(e: unknown): void }>)[props]!.onPointerDown({ preventDefault() {}, clientX: 500 }));
		await pointer("pointermove", 560);
		assert.equal(Number.parseInt(q("work-view")!.style.width, 10), w0 + 60);
		await pointer("pointerup", 560);
		assert.equal(store.get(WORK_COL_WIDTH_KEY), String(w0 + 60));
		await act(async () => (handle as unknown as Record<string, { onPointerDown(e: unknown): void }>)[props]!.onPointerDown({ preventDefault() {}, clientX: 0 }));
		await pointer("pointermove", 5000);
		assert.ok(Number.parseInt(q("work-view")!.style.width, 10) <= 720);
		await pointer("pointerup", 5000);
		assert.equal(store.get(WORK_COL_WIDTH_KEY), String(Math.min(720, Math.floor(1400 * 0.7))));
	});
	it("reopens at the remembered width", async () => {
		store.set(WORK_COL_WIDTH_KEY, "400");
		await openAndSelect("e");
		assert.equal(q("work-view")!.style.width, "400px");
	});
});

describe("entry points", () => {
	it("the sidebar entry opens the graph page when you're elsewhere, and the view", async () => {
		await mount("/pipeline");
		await click(q("nav-work")!);
		assert.deepEqual(pushed, ["/"]);
		assert.ok(q("work-view"));
	});
	it("on the graph page the sidebar entry just opens the view", async () => {
		await mount("/");
		await click(q("nav-work")!);
		assert.deepEqual(pushed, []);
		assert.ok(q("work-view"));
	});
	it("works from either entry: selecting from the header's button splits too", async () => {
		await openAndSelect("fx");
		assert.ok(q("work-resize"));
		assert.equal(q("fake-graph")!.getAttribute("data-selected"), "fx");
	});
});

describe("routeView", () => {
	it("rawWorkId is the graph's id mapping", () => {
		assert.equal(rawWorkId("work:e"), "e");
	});
});
