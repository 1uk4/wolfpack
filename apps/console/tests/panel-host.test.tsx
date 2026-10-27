/** The switchable right-panel host: switching, openPanel with props, Memory panel inside, unavailable panels hidden. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
	// the Memory panel's fetches: an unbound, quiet thread
	fetch: async () => new Response(JSON.stringify({ state: "off", bound: null, pool: null }), { status: 200 }),
});

const { PanelHostProvider, RightPanelHost, usePanelHost, PANELS } = await import("../components/panel-host.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
type PanelDef = (typeof PANELS)[number];

const quietSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });
const note = (id: string, available = true): PanelDef => ({
	id,
	label: id.toUpperCase(),
	icon: () => null,
	available: () => available,
	render: ({ props }) => <div data-testid={`body-${id}`} data-props={JSON.stringify(props)} />,
});

let root: Root | null = null;
let api: ReturnType<typeof usePanelHost>;
function Probe() {
	api = usePanelHost();
	return null;
}
async function mount(panels: readonly PanelDef[], threadId = "t1") {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<MemoryEventsProvider connect={quietSource}>
				<PanelHostProvider wolf="w" threadId={threadId} panels={panels}>
					<Probe />
					<RightPanelHost />
				</PanelHostProvider>
			</MemoryEventsProvider>,
		);
	});
}
beforeEach(() => store.clear());
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
const tabs = () => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent);

describe("panel host", () => {
	it("the default registry puts Memory first and keeps Subagent hidden", async () => {
		assert.deepEqual(PANELS.map((p) => p.id), ["memory", "subagent"]);
		await mount(PANELS);
		assert.deepEqual(tabs(), ["Status"]);
		assert.equal(q('[data-testid="panel-host"]')!.getAttribute("data-panel"), "memory");
		assert.equal(api.openPanel("subagent", { childThreadId: "c1" }), false);
		assert.equal(q('[data-testid="subagent-panel"]'), null);
		assert.equal(api.selected, "memory");
	});

	it("still renders the Memory panel body (embedded, one aside)", async () => {
		await mount(PANELS);
		assert.ok(q('[data-testid="panel-body-memory"] [data-testid="memory-feed"]'));
		assert.equal(q('[data-testid="memory-panel"]'), null);
		assert.equal(document.querySelectorAll("aside").length, 1);
	});

	it("lists available panels, hides unavailable ones, and switches on click", async () => {
		await mount([note("memory"), note("a"), note("hidden", false)]);
		assert.deepEqual(tabs(), ["MEMORY", "A"]);
		assert.ok(q('[data-testid="body-memory"]'));
		await click(q('[data-testid="panel-tab-a"]')!);
		assert.ok(q('[data-testid="body-a"]'));
		assert.equal(q('[data-testid="body-memory"]'), null);
		assert.equal(q('[data-testid="panel-tab-a"]')!.getAttribute("aria-selected"), "true");
	});

	it("openPanel selects the panel with its props and opens a collapsed host", async () => {
		await mount([note("memory"), note("subagent")]);
		await click(q('[aria-label="Collapse side panel"]')!);
		assert.equal(q('[data-testid="panel-host"]')!.getAttribute("data-open"), "false");
		let ok = false;
		await act(async () => void (ok = api.openPanel("subagent", { childThreadId: "c9" })));
		assert.equal(ok, true);
		assert.equal(q('[data-testid="panel-host"]')!.getAttribute("data-open"), "true");
		assert.equal(JSON.parse(q('[data-testid="body-subagent"]')!.getAttribute("data-props")!).childThreadId, "c9");
		// switching away and back keeps the props
		await click(q('[data-testid="panel-tab-memory"]')!);
		await click(q('[data-testid="panel-tab-subagent"]')!);
		assert.equal(JSON.parse(q('[data-testid="body-subagent"]')!.getAttribute("data-props")!).childThreadId, "c9");
		await act(async () => api.closePanel());
		assert.equal(q('[data-testid="panel-host"]')!.getAttribute("data-open"), "false");
	});

	it("openPanel refuses unknown and unavailable panels", async () => {
		await mount([note("memory"), note("off", false)]);
		assert.equal(api.openPanel("off"), false);
		assert.equal(api.openPanel("nope"), false);
		assert.equal(api.selected, "memory");
	});

	it("remembers the selection per thread", async () => {
		const panels = [note("memory"), note("a")];
		await mount(panels, "t1");
		await click(q('[data-testid="panel-tab-a"]')!);
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount(panels, "t1");
		assert.ok(q('[data-testid="body-a"]'));
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount(panels, "t2");
		assert.ok(q('[data-testid="body-memory"]'));
	});

	it("usePanelHost outside a provider is a harmless no-op", () => {
		assert.equal(typeof usePanelHost, "function");
	});
});
