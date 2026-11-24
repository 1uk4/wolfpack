/** Kind "prompt": the renderer (block and missing block), and the wolf settings page wiring (graph node click opens it, list gone, scope and kinds). */
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

const { PromptViewRenderer, PromptBlocksContext } = await import("../../../components/viewer/renderers/prompt-view.tsx");
const { WolfDetail } = await import("../../../components/pack/pack-wolves.tsx");
const { getViewerState, resetViewerCache } = await import("../../../components/viewer/viewer-store.ts");
const { FakeNav } = await import("../../helpers/fake-nav.tsx");

let root: Root | null = null;
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
async function mount(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start="/pack">{node}</FakeNav>));
}
beforeEach(() => {
	mem.clear();
	resetViewerCache();
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const BLOCK = { id: "system.identity", title: "Identity", source: "Edited for this wolf (identity.md)", flow: "Step 2 of 3 in System prompt. After: Header. Before: Orchestrator.", texts: [{ label: "Identity", text: "You are **Hal**." }] };
const renderer = (blocks: unknown, id: string, titles: string[] = []) => (
	<PromptBlocksContext.Provider value={{ blocks: blocks as never }}>
		<PromptViewRenderer descriptor={{ kind: "prompt", id }} onPush={() => {}} onTitle={(t) => titles.push(t)} onClose={() => {}} />
	</PromptBlocksContext.Provider>
);

describe("prompt renderer", () => {
	it("shows the block's title, source file, place in the flow and its text as markdown", async () => {
		const titles: string[] = [];
		await mount(renderer([BLOCK], "system.identity", titles));
		const t = document.body.textContent ?? "";
		assert.match(t, /Identity/);
		assert.match(t, /Edited for this wolf \(identity\.md\)/);
		assert.match(t, /Step 2 of 3 in System prompt\. After: Header\. Before: Orchestrator\./);
		assert.equal(q("strong")?.textContent, "Hal");
		assert.deepEqual(titles, ["Identity"]);
	});

	it("says the prompt block was not found for an id that no longer exists", async () => {
		await mount(renderer([BLOCK], "system.gone"));
		assert.match(q('[role="status"]')?.textContent ?? "", /Prompt block not found/);
	});
});

describe("wolf settings page", () => {
	const machine = { hostId: "mac", machine: "Mac", online: true, canSetKeys: true, servesConsole: true, pubkey: "PK", slots: [], wolves: [{ name: "hal", transport: "subscription" as const }] };
	const rows = [
		{ id: "system.header", group: "system", label: "Header", text: "H", source: "default", file: "header.ts" },
		{ id: "system.identity", group: "system", label: "Identity", text: "I", source: "default", file: "identity.md" },
	];
	const call = (async (u: string) =>
		String(u).endsWith("/prompts") ? Response.json({ prompts: rows }) : Response.json({ config: { name: "hal" }, etag: "e", editable: [] })) as typeof fetch;

	it("clicking a graph node opens kind prompt on the page's own stack, successive clicks push, and the list under the graph is gone", async () => {
		await mount(<WolfDetail machine={machine} wolf={machine.wolves[0]!} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} onBack={() => {}} />);
		await flush();
		assert.equal(q('[data-testid="wolf-prompt-list"]'), null);
		const hits = () => [...document.querySelectorAll('[data-testid="graph-node-hit"]')] as HTMLElement[];
		const click = async (i: number) => { await act(async () => void hits()[i]!.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0 }))); await flush(); };
		await click(0);
		await click(1);
		const stack = getViewerState("page", "settings:hal").stack.map((d) => `${d.kind}:${d.id}`);
		assert.deepEqual(stack, ["prompt:system.header", "prompt:system.identity"]);
		assert.match(q('[data-testid="viewer-panel"]')?.textContent ?? "", /Identity/);
	});
});
