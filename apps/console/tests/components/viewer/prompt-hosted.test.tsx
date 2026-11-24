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
const { FakeNav, currentUrl, navOptions } = await import("../../helpers/fake-nav.tsx");

let root: Root | null = null;
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
async function mount(node: React.ReactNode, start = "/pack") {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start={start}>{node}</FakeNav>));
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

const PROMPTS = "/pack/wolves?wolfTab=prompts";
describe("wolf settings page", () => {
	const machine = { hostId: "mac", machine: "Mac", online: true, canSetKeys: true, servesConsole: true, pubkey: "PK", slots: [], wolves: [{ name: "hal", transport: "subscription" as const }] };
	const rows = [
		{ id: "system.header", group: "system", label: "Header", text: "H", source: "default", file: "header.ts" },
		{ id: "system.identity", group: "system", label: "Identity", text: "I", source: "default", file: "identity.md" },
	];
	const call = (async (u: string) =>
		String(u).endsWith("/prompts") ? Response.json({ prompts: rows }) : Response.json({ config: { name: "hal" }, etag: "e", editable: [] })) as typeof fetch;

	it("clicking a graph node opens kind prompt on the page's own stack, successive clicks push, and the list under the graph is gone", async () => {
		await mount(<WolfDetail machine={machine} wolf={machine.wolves[0]!} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} onBack={() => {}} />, PROMPTS);
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

	it("keeps the viewer panel outside the page's scrolling column, so scrolling the graph never scrolls the viewer away", async () => {
		await mount(<WolfDetail machine={machine} wolf={machine.wolves[0]!} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} onBack={() => {}} />, PROMPTS);
		await flush();
		await act(async () => void (document.querySelector('[data-testid="graph-node-hit"]') as HTMLElement).dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0 })));
		await flush();
		const panel = q('[data-testid="viewer-panel"]')!;
		const scroller = q('[data-testid="wolf-prompts"]')!.closest(".overflow-y-auto");
		assert.notEqual(scroller, null, "the page content has its own scroll column");
		assert.equal(scroller!.contains(panel), false);
		assert.equal(panel.closest(".overflow-y-auto") === null || panel.closest(".overflow-y-auto") === q('[data-testid="viewer-body"]'), true);
	});

	it("the selected wolf is in the URL (wolf=<host>/<name>): a link restores the detail, Wolves clears it", async () => {
		const { WolvesView } = await import("../../../components/pack/pack-wolves.tsx");
		await mount(<WolvesView machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} />, "/pack/wolves?wolf=mac%2Fhal&wolfTab=prompts");
		await flush();
		assert.notEqual(q('[data-testid="wolf-detail-hal"]'), null);
		await act(async () => void (q('[data-testid="wolf-back"]') as HTMLElement).dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0 })));
		await flush();
		assert.equal(q('[data-testid="wolf-detail-hal"]'), null);
		const p = new URL(currentUrl(), "http://x").searchParams;
		assert.equal(p.get("wolf"), null);
		assert.equal(p.get("wolfTab"), null);
		assert.equal(new URL(currentUrl(), "http://x").pathname, "/pack/wolves");
	});

	describe("Wolf page tabs", () => {
		const detail = () => <WolfDetail machine={machine} wolf={machine.wolves[0]!} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} onBack={() => {}} />;
		const tab = (name: string) => [...document.querySelectorAll('[role="tablist"][aria-label="Wolf page"] [role="tab"]')].find((t) => t.textContent === name) as HTMLElement;
		const press = async (el: HTMLElement) => { await act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0 }))); await flush(); };

		it("opens on Models (the default) with the picker card and keys, and no prompts graph", async () => {
			await mount(detail());
			await flush();
			assert.equal(tab("Models").getAttribute("aria-selected"), "true");
			assert.equal(tab("Prompts").getAttribute("aria-selected"), "false");
			assert.notEqual(q('[data-testid="wolf-models"]'), null);
			assert.notEqual(q('[data-testid="wolf-keys"]'), null);
			assert.equal(q('[data-testid="wolf-prompts"]'), null);
		});

		const full = (threshold: number, etag: string) => ({ config: { name: "hal", compaction: { threshold } }, etag, editable: ["color", "compaction.threshold", "subagents.enabled", "memory.enabled", "other.thing"], env: [{ name: "ANTHROPIC_API_KEY", set: true, secret: true, purpose: "chat" }], restartNeeded: true, restartable: true, restartAvailableInSeconds: 0 });
		const fullCall = (async (u: string, init?: RequestInit) => {
			if (String(u).endsWith("/prompts")) return Response.json({ prompts: rows });
			return Response.json(init?.method === "PUT" ? full(90, "e2") : full(80, "e1"));
		}) as typeof fetch;
		const fullDetail = () => <WolfDetail machine={machine} wolf={machine.wolves[0]!} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={fullCall} onBack={() => {}} />;
		const has = (id: string) => q(`[data-testid="section-${id}"]`) !== null;

		it("has the tabs Appearance, Models, Behaviour, Access, wolf.yaml, Prompts in order, and no All settings disclosure", async () => {
			await mount(fullDetail());
			await flush();
			const names = [...document.querySelectorAll('[role="tablist"][aria-label="Wolf page"] [role="tab"]')].map((t) => t.textContent);
			assert.deepEqual(names, ["Appearance", "Models", "Behaviour", "Access", "wolf.yaml", "Prompts"]);
			assert.equal(q('[data-testid="wolf-all-settings"]'), null);
			assert.equal(document.querySelector("details"), null);
		});

		it("each tab shows its own sections and not the others'", async () => {
			await mount(fullDetail());
			await flush();
			const ids = ["color", "models", "subagents", "compaction", "memory", "other", "env", "config"];
			const want: Record<string, string[]> = { Appearance: ["color"], Models: [], Behaviour: ["subagents", "compaction", "memory", "other"], Access: ["env"], "wolf.yaml": ["config"] };
			for (const [name, shown] of Object.entries(want)) {
				await press(tab(name));
				assert.deepEqual(ids.filter(has), shown, name);
			}
			await press(tab("Access"));
			assert.notEqual(q('[data-testid="wolf-domains"]'), null);
			await press(tab("Models"));
			assert.notEqual(q('[data-testid="wolf-keys"]'), null);
		});

		it("the Restart control is in the page header on every tab", async () => {
			await mount(fullDetail());
			await flush();
			for (const name of ["Models", "Access", "Prompts"]) {
				await press(tab(name));
				assert.notEqual(q('[data-testid="restart-button"]'), null, name);
				assert.notEqual(q('[data-testid="banner-restart-needed"]'), null, name);
			}
		});

		it("a save on Behaviour shows in the wolf.yaml read-out on another tab (one shared view)", async () => {
			await mount(fullDetail());
			await flush();
			await press(tab("Behaviour"));
			const input = q('[data-testid="field-compaction.threshold"]') as HTMLInputElement;
			await act(async () => {
				input.value = "90";
				const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
				(input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!.onChange({ target: input, currentTarget: input });
			});
			await press(q('[data-testid="settings-save"]') as HTMLElement);
			await press(tab("wolf.yaml"));
			assert.match(q('[data-testid="section-config"]')?.textContent ?? "", /threshold:\s*90/);
		});

		it("an old wolfTab=overview link opens on Models", async () => {
			await mount(detail(), "/pack/wolves?wolfTab=overview");
			await flush();
			assert.equal(tab("Models").getAttribute("aria-selected"), "true");
		});

		it("clicking Prompts shows the graph, hides the cards and writes wolfTab=prompts to the URL, keeping ?pack", async () => {
			await mount(detail(), "/pack/wolves");
			await flush();
			await press(tab("Prompts"));
			assert.notEqual(q('[data-testid="wolf-prompts"]'), null);
			assert.equal(q('[data-testid="wolf-models"]'), null);
			const p = new URL(currentUrl(), "http://x").searchParams;
			assert.equal(p.get("wolfTab"), "prompts");
			assert.equal(new URL(currentUrl(), "http://x").pathname, "/pack/wolves");
		});

		it("opens on Prompts when the URL says wolfTab=prompts", async () => {
			await mount(detail(), PROMPTS);
			await flush();
			assert.equal(tab("Prompts").getAttribute("aria-selected"), "true");
			assert.notEqual(q('[data-testid="wolf-prompts"]'), null);
		});

		it("opens on Prompts, with the block open, for ?view=prompt:<id> even without wolfTab", async () => {
			await mount(detail(), "/pack/wolves?view=prompt:system.identity");
			await flush();
			assert.equal(tab("Prompts").getAttribute("aria-selected"), "true");
			assert.match(q('[data-testid="viewer-panel"]')?.textContent ?? "", /Identity/);
		});

		it("closing a viewer that was opened by ?view=prompt:<id> alone keeps the Prompts tab, and the URL says wolfTab=prompts", async () => {
			await mount(detail(), "/pack/wolves?view=prompt:system.identity");
			await flush();
			await press(q('[data-testid="viewer-close"]') as HTMLElement);
			assert.equal(tab("Prompts").getAttribute("aria-selected"), "true");
			assert.notEqual(q('[data-testid="wolf-prompts"]'), null);
			const p = new URL(currentUrl(), "http://x").searchParams;
			assert.equal(p.get("wolfTab"), "prompts");
			assert.equal(p.get("view"), null);
		});

		it("switching to Models closes the open prompt and clears ?view=", async () => {
			await mount(detail(), PROMPTS);
			await flush();
			await press(document.querySelector('[data-testid="graph-node-hit"]') as HTMLElement);
			assert.equal(getViewerState("page", "settings:hal").open, true);
			await press(tab("Models"));
			assert.equal(getViewerState("page", "settings:hal").open, false);
			const p = new URL(currentUrl(), "http://x").searchParams;
			assert.equal(p.get("view"), null);
			assert.equal(p.get("wolfTab"), null);
			assert.equal(new URL(currentUrl(), "http://x").pathname, "/pack/wolves");
		});

		it("one click on Models from Prompts with a prompt open from the URL switches in one write: Models selected, no view, no wolfTab", async () => {
			await mount(detail(), `${PROMPTS}&view=prompt:system.identity`);
			await flush();
			assert.equal(tab("Prompts").getAttribute("aria-selected"), "true");
			navOptions.defer = true; // like Next: the URL changes after a transition, so a second write reads stale params
			try {
				await press(tab("Models"));
				await flush();
			} finally {
				navOptions.defer = false;
			}
			const p = new URL(currentUrl(), "http://x").searchParams;
			assert.equal(p.get("view"), null);
			assert.equal(p.get("wolfTab"), null);
			assert.equal(tab("Models").getAttribute("aria-selected"), "true");
		});

		it("the graph box fills the height left under the tabs and filters (flex-1 with a min-height floor) instead of a fixed height", async () => {
			await mount(detail(), PROMPTS);
			await flush();
			const box = q('[data-testid="wolf-prompts-graph"]')!;
			assert.match(box.className, /\bflex-1\b/);
			assert.match(box.className, /\bmin-h-\[/);
			assert.doesNotMatch(box.className, /\bh-\[320px\]/);
		});
	});
});
