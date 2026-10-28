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
	// the Memory panel's fetches: status (optionally bound, with a pool) and the bound item's record
	fetch: async (url: string) =>
		String(url).endsWith("/memory/observations")
			? new Response(JSON.stringify({ observations: [], total: 0 }), { status: 200 })
			: new Response(JSON.stringify(boundMode ? (String(url).includes("/work/") ? workRecord : boundStatus) : { state: "off", bound: null, pool: null }), { status: 200 }),
});
let boundMode = false;
const workRecord = { id: "work-1", title: "Item", kind: "task", stage: "in_build", domain: "wolfpack", plan: "", record: "", dependsOn: [], children: [] };
const boundStatus = { state: "on", bound: { workId: "work-1", title: "Item" }, pool: { count: 1, tokens: 10, consolidateAtTokens: 100, poolTarget: 50, trigger: "tokens" } };

const { PanelHostProvider, RightPanelHost, usePanelHost, usePanelState, PANELS } = await import("../components/panel-host.tsx");
const { MemoryPanel } = await import("../components/memory-panel.tsx");
const { parseSelections, resolveSelected, withSelection, RIGHT_PANEL_KEY } = await import("../src/core/index.ts");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
type PanelDef = (typeof PANELS)[number];

let emit: (frame: unknown) => void = () => {};
let open = 0;
const quietSource = () => {
	open++;
	return {
		close: () => void open--,
		onOpen() {},
		onMessage: (cb: (data: string) => void) => void (emit = (f) => cb(JSON.stringify(f))),
		onError() {},
	};
};
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
const note = (id: string, available = true): PanelDef => ({
	id,
	label: id.toUpperCase(),
	icon: () => null,
	available: () => available,
	render: ({ props }) => <div data-testid={`body-${id}`} data-props={JSON.stringify(props)} />,
});

let root: Root | null = null;
let api: ReturnType<typeof usePanelHost>;
let state: ReturnType<typeof usePanelState>;
let probeRenders = 0;
function Probe() {
	api = usePanelHost();
	state = usePanelState();
	return null;
}
function ActionsOnly() {
	api = usePanelHost();
	probeRenders++;
	return null;
}
async function mount(panels: readonly PanelDef[], threadId = "t1", actionsOnly = false) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<MemoryEventsProvider connect={quietSource}>
				<PanelHostProvider wolf="w" threadId={threadId} panels={panels}>
					{actionsOnly ? <ActionsOnly /> : <Probe />}
					<RightPanelHost />
				</PanelHostProvider>
			</MemoryEventsProvider>,
		);
	});
}
beforeEach(() => {
	store.clear();
	boundMode = false;
	open = 0;
	emit = () => {};
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
const tabs = () => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent);

describe("panel host", () => {
	it("the default registry holds only Memory (subagents open a modal)", async () => {
		assert.deepEqual(PANELS.map((p) => p.id), ["memory"]);
		await mount(PANELS);
		assert.deepEqual(tabs(), ["Status"]);
		assert.equal(q('[data-testid="panel-host"]')!.getAttribute("data-panel"), "memory");
		assert.equal(api.openPanel("subagent", { childThreadId: "c1" }), false); // no such panel: the subagent opens a modal
		assert.equal(state.selected, "memory");
	});

	it("still renders the Memory panel body (embedded, one aside)", async () => {
		await mount(PANELS);
		assert.ok(q('[data-testid="memory-panel"] [data-testid="memory-feed"]'));
		assert.equal(q('[data-testid="memory-panel"]')!.getAttribute("data-open"), "true");
		assert.equal(document.querySelectorAll("aside").length, 1);
	});

	it("lists available panels, hides unavailable ones, and switches on click", async () => {
		await mount([note("memory"), note("a"), note("hidden", false)]);
		assert.deepEqual(tabs(), ["MEMORY", "A"]);
		assert.ok(q('[data-testid="body-memory"]'));
		await click(q('[data-testid="panel-tab-a"]')!);
		assert.ok(q('[data-testid="body-a"]'));
		assert.equal(q('[data-testid="body-a"]')!.parentElement!.hasAttribute("hidden"), false);
		// the deselected panel stays mounted, hidden
		assert.equal(q('[data-testid="body-memory"]')!.parentElement!.hasAttribute("hidden"), true);
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
		assert.equal(state.selected, "memory");
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

	it("openPanel outside a provider returns false (and warns once)", async () => {
		const warns: unknown[] = [];
		const orig = console.warn;
		console.warn = (...a) => void warns.push(a);
		try {
			const host = document.createElement("div");
			document.body.appendChild(host);
			root = createRoot(host);
			await act(async () => root!.render(<Probe />));
			assert.equal(api.openPanel("memory"), false);
			assert.equal(state.selected, null);
			assert.ok(warns.length <= 1);
		} finally {
			console.warn = orig;
		}
	});

	it("props are per thread: another thread never sees a childThreadId", async () => {
		const panels = [note("memory"), note("subagent")];
		await mount(panels, "t1");
		await act(async () => void api.openPanel("subagent", { childThreadId: "c1" }));
		assert.equal(JSON.parse(q('[data-testid="body-subagent"]')!.getAttribute("data-props")!).childThreadId, "c1");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount(panels, "t2");
		await click(q('[data-testid="panel-tab-subagent"]')!);
		assert.deepEqual(JSON.parse(q('[data-testid="body-subagent"]')!.getAttribute("data-props")!), {});
	});

	it("a component that only calls openPanel does not re-render when the panel changes", async () => {
		probeRenders = 0;
		await mount([note("memory"), note("a")], "t1", true);
		const before = probeRenders;
		await click(q('[data-testid="panel-tab-a"]')!);
		await click(q('[aria-label="Collapse side panel"]')!);
		assert.equal(probeRenders, before);
	});

	it("the collapse state persists under the Memory panel's open key", async () => {
		await mount([note("memory")]);
		await click(q('[aria-label="Collapse side panel"]')!);
		assert.equal(store.get("lh.memory-panel.open.v1"), "0");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount([note("memory")]);
		assert.equal(q('[data-testid="panel-host"]')!.getAttribute("data-open"), "false");
	});

	it("a stored selection for a panel that is gone or unavailable falls back to the default", async () => {
		store.set(RIGHT_PANEL_KEY, JSON.stringify({ t1: "subagent" }));
		await mount([note("memory"), note("subagent", false)]);
		assert.equal(state.selected, "memory");
		assert.ok(q('[data-testid="body-memory"]'));
	});

	it("only non-default selections are stored, merged with what storage already holds", async () => {
		await mount([note("memory"), note("a")], "t1");
		store.set(RIGHT_PANEL_KEY, JSON.stringify({ other: "a" }));
		await click(q('[data-testid="panel-tab-a"]')!);
		assert.deepEqual(JSON.parse(store.get(RIGHT_PANEL_KEY)!), { other: "a", t1: "a" });
		await click(q('[data-testid="panel-tab-memory"]')!);
		assert.deepEqual(JSON.parse(store.get(RIGHT_PANEL_KEY)!), { other: "a" });
	});

	it("Memory keeps its subscription, feed and unread across collapse, reopen and switching tabs", async () => {
		boundMode = true;
		await mount([PANELS[0]!, note("a")]);
		await settle();
		assert.equal(open, 1);
		const node = q('[data-testid="memory-panel"]')!;
		const obs = (summary: string) => emit({ type: "observation_captured", wolf: "w", threadId: "t1", summary, count: 1, target: { kind: "den", topicId: "x" } });
		await act(async () => obs("one"));
		assert.equal(q('[data-testid="memory-unread"]')!.textContent, "1");

		await click(q('[aria-label="Collapse side panel"]')!);
		assert.ok(q('[data-testid="memory-panel"]') === node, "same element, not remounted");
		assert.equal(node.getAttribute("data-open"), "false");
		assert.equal(open, 1);
		await act(async () => obs("two"));
		await click(q('[aria-label="Open side panel"]')!);
		assert.equal(q('[data-testid="memory-unread"]')!.textContent, "2");

		await click(q('[data-testid="panel-tab-a"]')!);
		assert.ok(q('[data-testid="body-a"]'));
		assert.equal(open, 1);
		await act(async () => obs("three"));
		await click(q('[data-testid="panel-tab-memory"]')!);
		assert.ok(q('[data-testid="memory-panel"]') === node);
		assert.equal(q('[data-testid="memory-unread"]')!.textContent, "3");
		await click(q('[data-testid="memory-observations"]')!);
		assert.ok(q('[data-testid="memory-feed"]'));
	});
});

describe("panel host model", () => {
	it("parseSelections tolerates bad JSON, arrays, non-objects and non-string ids", () => {
		assert.deepEqual(parseSelections(null), {});
		assert.deepEqual(parseSelections("{nope"), {});
		assert.deepEqual(parseSelections("[1]"), {});
		assert.deepEqual(parseSelections("3"), {});
		assert.deepEqual(parseSelections("null"), {});
		assert.deepEqual(parseSelections('{"a":"x","b":1,"c":"","d":null}'), { a: "x" });
	});
	it("resolveSelected: stored if available, else memory, else the first, else null", () => {
		assert.equal(resolveSelected("a", ["memory", "a"]), "a");
		assert.equal(resolveSelected("gone", ["a", "memory"]), "memory");
		assert.equal(resolveSelected(undefined, ["a", "b"]), "a");
		assert.equal(resolveSelected("a", []), null);
	});
	it("withSelection drops default entries, moves the thread last and caps at the most recent", () => {
		assert.deepEqual(withSelection({ t: "a" }, "t", "memory"), {});
		assert.deepEqual(Object.keys(withSelection({ t: "a", u: "a" }, "t", "b")), ["u", "t"]);
		const big = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`t${i}`, "a"]));
		assert.deepEqual(Object.keys(withSelection(big, "n", "a", 3)), ["t3", "t4", "n"]);
	});
});

describe("embedded MemoryPanel", () => {
	it("renders the body only: no aside, no collapse control, and it ignores the stored open flag", async () => {
		store.set("lh.memory-panel.open.v1", "0");
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () =>
			root!.render(
				<MemoryEventsProvider connect={quietSource}>
					<MemoryPanel embedded wolf="w" threadId="t1" />
				</MemoryEventsProvider>,
			),
		);
		assert.equal(document.querySelectorAll("aside").length, 0);
		assert.equal(q('[aria-label="Collapse status panel"]'), null);
		assert.ok(q('[data-testid="memory-feed"]'));
	});
});
