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
const { FakeNav, currentUrl, navOptions, navLog, historyBack } = await import("../../helpers/fake-nav.tsx");

let root: Root | null = null;
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
async function mount(node: React.ReactNode, start = "/pack/wolves/mac/hal") {
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

const PROMPTS = "/pack/wolves/mac/hal/prompts";
describe("wolf settings page", () => {
	const machine = { hostId: "mac", machine: "Mac", online: true, canSetKeys: true, servesConsole: true, pubkey: "PK", slots: [], wolves: [{ name: "hal", transport: "subscription" as const }, { name: "dewey", transport: "subscription" as const }] };
	const rows = [
		{ id: "system.header", group: "system", label: "Header", text: "H", source: "default", file: "header.ts" },
		{ id: "system.identity", group: "system", label: "Identity", text: "I", source: "default", file: "identity.md" },
	];
	const call = (async (u: string) =>
		String(u).endsWith("/prompts") ? Response.json({ prompts: rows }) : Response.json({ config: { name: "hal" }, etag: "e", editable: [] })) as typeof fetch;

	it("clicking a graph node opens kind prompt on the page's own stack, successive clicks push, and the list under the graph is gone", async () => {
		await mount(<WolfDetail machine={machine} wolf={machine.wolves[0]!} machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} />, PROMPTS);
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
		await mount(<WolfDetail machine={machine} wolf={machine.wolves[0]!} machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} />, PROMPTS);
		await flush();
		await act(async () => void (document.querySelector('[data-testid="graph-node-hit"]') as HTMLElement).dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0 })));
		await flush();
		const panel = q('[data-testid="viewer-panel"]')!;
		const scroller = q('[data-testid="wolf-prompts"]')!.closest(".overflow-y-auto");
		assert.notEqual(scroller, null, "the page content has its own scroll column");
		assert.equal(scroller!.contains(panel), false);
		assert.equal(panel.closest(".overflow-y-auto") === null || panel.closest(".overflow-y-auto") === q('[data-testid="viewer-body"]'), true);
	});

	it("the wolf is in the path (/pack/wolves/<host>/<name>/<tab>): a link restores the detail on that tab, and there is no \"← Wolves\" button", async () => {
		const { WolvesView } = await import("../../../components/pack/pack-wolves.tsx");
		await mount(<WolvesView machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} />, "/pack/wolves/mac/hal/prompts");
		await flush();
		assert.notEqual(q('[data-testid="wolf-detail-hal"]'), null);
		assert.notEqual(q('[data-testid="wolf-prompts"]'), null);
		assert.equal(q('[data-testid="wolf-back"]'), null);
	});

	it("the list rows open the wolf's path (a navigation, so Back returns to the list)", async () => {
		const { WolvesView } = await import("../../../components/pack/pack-wolves.tsx");
		await mount(<WolvesView machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} />, "/pack/wolves");
		await flush();
		await act(async () => void (q('[data-testid="wolf-row-hal"]') as HTMLElement).dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0 })));
		await flush();
		assert.equal(currentUrl(), "/pack/wolves/mac/hal");
		assert.equal(navLog.stack.length, 2);
	});

	describe("Wolf page tabs", () => {
		const detail = () => <WolfDetail machine={machine} wolf={machine.wolves[0]!} machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} />;
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
		const fullDetail = () => <WolfDetail machine={machine} wolf={machine.wolves[0]!} machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={fullCall} />;
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

		it("clicking Prompts shows the graph, hides the cards and navigates (push) to the prompts path", async () => {
			await mount(detail(), "/pack/wolves/mac/hal");
			await flush();
			await press(tab("Prompts"));
			assert.notEqual(q('[data-testid="wolf-prompts"]'), null);
			assert.equal(q('[data-testid="wolf-models"]'), null);
			assert.equal(currentUrl(), "/pack/wolves/mac/hal/prompts");
			assert.equal(navLog.stack.length, 2);
		});

		it("opens on Prompts when the path says /prompts", async () => {
			await mount(detail(), PROMPTS);
			await flush();
			assert.equal(tab("Prompts").getAttribute("aria-selected"), "true");
			assert.notEqual(q('[data-testid="wolf-prompts"]'), null);
		});

		it("opens on Prompts, with the block open, for ?view=prompt:<id> on a non-prompts path, and the URL ends on /prompts keeping view", async () => {
			await mount(detail(), "/pack/wolves/mac/hal?view=prompt:system.identity");
			await flush();
			assert.equal(tab("Prompts").getAttribute("aria-selected"), "true");
			assert.match(q('[data-testid="viewer-panel"]')?.textContent ?? "", /Identity/);
			assert.equal(currentUrl(), "/pack/wolves/mac/hal/prompts?view=prompt%3Asystem.identity");
		});

		it("closing a viewer that was opened by ?view=prompt:<id> alone keeps the Prompts tab, and the path stays /prompts", async () => {
			await mount(detail(), "/pack/wolves/mac/hal?view=prompt:system.identity");
			await flush();
			await press(q('[data-testid="viewer-close"]') as HTMLElement);
			assert.equal(tab("Prompts").getAttribute("aria-selected"), "true");
			assert.notEqual(q('[data-testid="wolf-prompts"]'), null);
			assert.equal(currentUrl(), "/pack/wolves/mac/hal/prompts");
		});

		it("switching to Models closes the open prompt and clears ?view=", async () => {
			await mount(detail(), PROMPTS);
			await flush();
			await press(document.querySelector('[data-testid="graph-node-hit"]') as HTMLElement);
			assert.equal(getViewerState("page", "settings:hal").open, true);
			await press(tab("Models"));
			assert.equal(getViewerState("page", "settings:hal").open, false);
			assert.equal(currentUrl(), "/pack/wolves/mac/hal");
		});

		it("one click on Models from Prompts with a prompt open from the URL switches in one write: Models selected, no view, no wolfTab", async () => {
			await mount(detail(), `${PROMPTS}?view=prompt:system.identity`);
			await flush();
			assert.equal(tab("Prompts").getAttribute("aria-selected"), "true");
			navOptions.defer = true; // like Next: the URL changes after a transition, so a second write reads stale params
			navLog.writes = 0;
			try {
				await press(tab("Models"));
				await flush();
			} finally {
				navOptions.defer = false;
			}
			assert.equal(navLog.writes, 1);
			assert.equal(currentUrl(), "/pack/wolves/mac/hal");
			assert.equal(tab("Models").getAttribute("aria-selected"), "true");
		});

		it("has no \"← Wolves\" button; the wolf row has a dropdown of every wolf, on the machine, with Restart and Reload", async () => {
			await mount(fullDetail(), "/pack/wolves/mac/hal");
			await flush();
			assert.equal(q('[data-testid="wolf-back"]'), null);
			assert.equal([...document.querySelectorAll("button")].some((b) => /Wolves/.test(b.textContent ?? "")), false);
			const row = q('[data-testid="wolf-row"]')!;
			const options = [...row.querySelectorAll('select[aria-label="Wolf"] option')].map((o) => o.textContent);
			assert.deepEqual(options, ["hal", "dewey"]);
			assert.match(row.textContent ?? "", /on Mac/);
			assert.notEqual(row.querySelector('[data-testid="restart-button"]'), null);
			assert.notEqual(row.querySelector('[data-testid="settings-reload"]'), null);
		});

		it("choosing another wolf in the dropdown goes to the same tab on that wolf and drops view", async () => {
			await mount(fullDetail(), `${PROMPTS}?view=prompt:system.identity`);
			await flush();
			const sel = q('select[aria-label="Wolf"]') as HTMLSelectElement;
			await act(async () => {
				const key = Object.keys(sel).find((k) => k.startsWith("__reactProps$"))!;
				(sel as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!.onChange({ target: { value: "mac/dewey" }, currentTarget: { value: "mac/dewey" } });
			});
			await flush();
			assert.equal(currentUrl(), "/pack/wolves/mac/dewey/prompts");
		});

		it("Restart is emphasised only when a restart is needed", async () => {
			await mount(fullDetail(), "/pack/wolves/mac/hal");
			await flush();
			const btn = q('[data-testid="restart-button"]')!;
			assert.equal(btn.getAttribute("data-emphasis"), "true"); // the fixture says restartNeeded
			await act(async () => root?.unmount());
			document.body.innerHTML = "";
			await mount(<WolfDetail machine={machine} wolf={machine.wolves[0]!} machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={(async (u: string) => String(u).endsWith("/prompts") ? Response.json({ prompts: rows }) : Response.json({ ...full(80, "e1"), restartNeeded: false })) as typeof fetch} />, "/pack/wolves/mac/hal");
			await flush();
			assert.equal(q('[data-testid="restart-button"]')!.getAttribute("data-emphasis"), "false");
		});

		it("the scope filters are aria-pressed buttons in a group inside the graph toolbar, not tabs", async () => {
			await mount(detail(), PROMPTS);
			await flush();
			const bar = q('[data-testid="graph-toolbar"]')!;
			const all = bar.querySelector('[data-testid="scope-all"]') as HTMLElement;
			assert.notEqual(all, null);
			assert.equal(all.getAttribute("aria-pressed"), "true");
			assert.equal(all.getAttribute("role"), null);
			assert.equal(all.parentElement?.getAttribute("role"), "group");
			assert.equal(document.querySelectorAll('[role="tablist"]').length, 1);
			await press(bar.querySelector('[data-testid="scope-wolf"]') as HTMLElement);
			assert.equal(q('[data-testid="scope-wolf"]')!.getAttribute("aria-pressed"), "true");
			assert.equal(q('[data-testid="scope-all"]')!.getAttribute("aria-pressed"), "false");
		});

		it("browser Back from an open prompt leaves it: the viewer closes and the URL goes to the entry before the Prompts tab", async () => {
			await mount(detail(), "/pack/wolves/mac/hal");
			await flush();
			await press(tab("Prompts"));
			await press(document.querySelector('[data-testid="graph-node-hit"]') as HTMLElement);
			assert.match(currentUrl(), /\/prompts\?view=prompt/);
			await act(async () => historyBack());
			await flush();
			assert.equal(currentUrl(), "/pack/wolves/mac/hal");
			assert.equal(getViewerState("page", "settings:hal").open, false);
		});

		const typeThreshold = async (value: string) => {
			const input = q('[data-testid="field-compaction.threshold"]') as HTMLInputElement;
			await act(async () => {
				input.value = value;
				const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
				(input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!.onChange({ target: input, currentTarget: input });
			});
		};
		const thresholdValue = () => (q('[data-testid="field-compaction.threshold"]') as HTMLInputElement).value;

		it("an unsaved edit survives a tab switch, and the Save row shows only on tabs with form fields", async () => {
			await mount(fullDetail());
			await flush();
			await press(tab("Models"));
			assert.equal(q('[data-testid="settings-save"]'), null, "Models has no form field here");
			await press(tab("Behaviour"));
			await typeThreshold("95");
			await press(tab("Models"));
			await press(tab("Behaviour"));
			assert.equal(thresholdValue(), "95");
		});

		it("drafts are cleared when a restart completes", async () => {
			let restarted = false;
			let gets = 0;
			const restartCall = (async (u: string, init?: RequestInit) => {
				if (String(u).endsWith("/prompts")) return Response.json({ prompts: rows });
				if (String(u).endsWith("/restart")) return (restarted = true), Response.json({});
				if (restarted && gets++ === 0) return new Response("{}", { status: 502 }); // the wolf is down, then back
				return Response.json(init?.method === "PUT" ? full(90, "e2") : full(80, "e1"));
			}) as typeof fetch;
			await mount(<WolfDetail machine={machine} wolf={machine.wolves[0]!} machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={restartCall} />);
			await flush();
			await press(tab("Behaviour"));
			await typeThreshold("95");
			await press(q('[data-testid="restart-button"]') as HTMLElement);
			await act(async () => { await new Promise((r) => setTimeout(r, 4400)); });
			assert.equal(q('[data-testid="banner-restart-pending"]'), null);
			assert.equal(thresholdValue(), "80");
		});

		it("Arrow, Home and End move focus only (no history entry); every tab and panel is linked by id, aria-controls and aria-labelledby", async () => {
			await mount(fullDetail(), "/pack/wolves/mac/hal");
			await flush();
			const key = async (el: HTMLElement, k: string) => { await act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: k }))); await flush(); };
			const focused: string[] = [];
			const orig = dom.window.HTMLElement.prototype.focus;
			dom.window.HTMLElement.prototype.focus = function (this: HTMLElement) { focused.push(this.id); };
			const before = navLog.stack.length;
			for (const k of ["ArrowRight", "ArrowLeft", "End", "Home"]) await key(tab("Models"), k);
			assert.equal(navLog.stack.length, before);
			assert.equal(currentUrl(), "/pack/wolves/mac/hal");
			await key(tab("Models"), "End");
			assert.equal(focused.at(-1), "wolf-tab-prompts");
			await key(tab("Models"), "Home");
			assert.equal(focused.at(-1), "wolf-tab-appearance");
			dom.window.HTMLElement.prototype.focus = orig;
			const models = tab("Models");
			const panel = q('[role="tabpanel"]')!;
			assert.equal(models.getAttribute("aria-controls"), panel.id);
			assert.equal(panel.getAttribute("aria-labelledby"), models.id);
			assert.notEqual(panel.id, "");
		});

		it("a wolf name containing a slash survives the switcher", async () => {
			await mount(fullDetail(), "/pack/wolves/mac/hal");
			await flush();
			const sel = q('select[aria-label="Wolf"]') as HTMLSelectElement;
			await act(async () => {
				const key = Object.keys(sel).find((k) => k.startsWith("__reactProps$"))!;
				(sel as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!.onChange({ target: { value: "mac/a%2Fb" }, currentTarget: { value: "mac/a%2Fb" } });
			});
			await flush();
			assert.equal(currentUrl(), "/pack/wolves/mac/a%2Fb");
		});

		it("a wolf path whose wolf is not in the pack says Wolf not found, with a link to the list", async () => {
			const { WolvesView } = await import("../../../components/pack/pack-wolves.tsx");
			await mount(<WolvesView machines={[machine]} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={call} />, "/pack/wolves/mac/ghost");
			await flush();
			assert.match(document.body.textContent ?? "", /Wolf not found/);
			assert.equal(q('a[href="/pack/wolves"]')?.textContent, "All wolves");
			assert.doesNotMatch(document.body.textContent ?? "", /No wolves have reported/);
		});
	});
});
