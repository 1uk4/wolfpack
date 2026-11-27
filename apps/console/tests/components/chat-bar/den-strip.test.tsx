/** The den strip on the floating chat (work-wolfpack-XR2Jmxf): a wolf button with its badge, a click opens the needs-you sheet, Esc or a second click closes it, a row opens its thread. Real mount, stubbed fetch. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const mem = new Map<string, string>();
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { FakeNav, navLog } = await import("../../helpers/fake-nav.tsx");
const { dataStore } = await import("../../../src/core/data-store.ts");
const { AttachedThreadProvider } = await import("../../../components/chat-bar/attached-thread.tsx");
const { ChatBar } = await import("../../../components/chat-bar/chat-bar.tsx");
const { ATTACHED_KEY } = await import("../../../src/core/thread/chat-bar.ts");

const handlers = new Map<string, (d: string) => void>();
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) });
const realFetch = globalThis.fetch;
const th = (id: string, extra: object = {}) => ({ id, title: id, kind: "feature", status: "idle", ...extra });
const ITEM = { wolf: "hal", threadId: "hal/b", threadTitle: "Sync worker", slug: "b", href: "/wolf/hal/thread/b", callId: "c1", card: { tool: "ask", title: "Restart the sync worker?", fields: [] }, raisedAt: "2026-11-09T00:00:00Z" };
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url === "/api/needs-you") return Response.json({ items: [ITEM] });
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }, { name: "hal" }, { name: "solo" }] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [th("w/home", { kind: "home", status: "busy" }), th("w/a")] });
	if (url === "/api/wolves/solo/threads") return Response.json({ threads: [th("solo/x")] });
	if (url === "/api/wolves/hal/threads") return Response.json({ threads: [th("hal/home", { kind: "home" }), th("hal/b", { status: "needs-you" })] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

let root: Root | null = null;
const flush = () => act(async () => void (await Promise.all([1, 2, 3, 4, 5, 6].map(() => new Promise((r) => setImmediate(r))))));
const until = async (cond: () => unknown, what: string) => {
	for (let i = 0; i < 100; i++) {
		if (cond()) return;
		await flush();
	}
	assert.fail(`timed out waiting for ${what}`);
};
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const props = (el: HTMLElement, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];
const click = (el: HTMLElement) => act(async () => void props(el, "onClick")({ currentTarget: el, target: el, preventDefault() {}, stopPropagation() {} }));
const wolf = (name: string) => q(`[data-testid="den-wolf"][data-wolf="${name}"]`)!;

async function mount(path = "/kb") {
	mem.set(ATTACHED_KEY, JSON.stringify({ wolf: "w", slug: "a", threadId: "w/a" }));
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start={path}>
				<ServerEventsProvider connect={fakeSource}>
					<AttachedThreadProvider>
						<ChatBar />
					</AttachedThreadProvider>
				</ServerEventsProvider>
			</FakeNav>,
		);
	});
	await until(() => q('[data-testid="den-strip"]'), "the strip");
	await until(() => wolf("hal").querySelector('[data-testid="den-badge"]'), "the badge");
}

afterEach(async () => {
	dataStore.clear();
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	mem.clear();
	handlers.clear();
});
after(() => void (globalThis.fetch = realFetch));

describe("den strip", () => {
	it("shows a button per wolf with its working dot and needs-you badge, named for a screen reader", async () => {
		await mount();
		assert.equal(wolf("w").getAttribute("aria-label"), "w, working");
		assert.ok(wolf("w").querySelector('[data-testid="den-working"]'));
		assert.equal(wolf("hal").getAttribute("aria-label"), "hal, 1 needs you");
		assert.equal(wolf("hal").querySelector('[data-testid="den-badge"]')?.textContent, "1");
		assert.equal(wolf("hal").querySelector('[data-testid="den-working"]'), null);
	});

	it("a click opens the wolf's sheet, Esc closes it, and a second click closes it too", async () => {
		await mount();
		assert.equal(q('[data-testid="den-sheet"]'), null);
		await click(wolf("hal"));
		await until(() => q('[data-testid="den-row"]'), "the row");
		assert.equal(q('[data-testid="den-sheet"]')?.getAttribute("aria-label"), "hal: switch thread");
		assert.match(q('[data-testid="den-row"]')!.textContent ?? "", /Restart the sync worker\?/);
		await act(async () => void document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key: "Escape" })));
		assert.equal(q('[data-testid="den-sheet"]'), null, "Esc closes");
		await click(wolf("hal"));
		assert.ok(q('[data-testid="den-sheet"]'));
		await click(wolf("hal"));
		assert.equal(q('[data-testid="den-sheet"]'), null, "a second click closes");
	});

	it("a needs-you row opens its thread, attaches the chat to the thread that raised it, and closes the sheet", async () => {
		await mount();
		await click(wolf("hal"));
		await until(() => q('[data-testid="den-row"] a'), "the row");
		await click(q('[data-testid="den-row"] a')!);
		assert.equal(navLog.stack[navLog.index], "/wolf/hal/thread/b");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "hal/b");
		assert.equal(q('[data-testid="den-sheet"]'), null);
	});

	it("the sheet lists the wolf's threads, marks the attached one, and a thread row attaches the chat to it and closes the sheet, even with nothing waiting", async () => {
		await mount();
		await click(wolf("hal"));
		const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="den-thread"]'));
		assert.equal(rows[0]!.getAttribute("data-thread"), "hal/home", "home leads");
		assert.equal(q('[data-testid="den-thread"][aria-current="true"]'), null, "the chat is attached to another wolf");
		await click(rows[0]!);
		await flush();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "hal/home");
		assert.equal(q('[data-testid="den-sheet"]'), null);
	});

	it("the tree opens inside the bar's own card (no popover), with the home thread as a House and feature threads as the Work icon, cards nested under their thread", async () => {
		await mount();
		await click(wolf("hal"));
		await until(() => q('[data-testid="den-row"]'), "the card row");
		const tree = q('[data-testid="den-sheet"]')!;
		assert.equal(tree.getAttribute("data-layout"), "inline");
		assert.equal(!!tree.closest('[data-testid="chat-bar"] .rounded-2xl'), true, "inside the bar's card");
		assert.equal(tree.className.includes("absolute") || tree.className.includes("fixed"), false, "nothing floats");
		const kinds = Array.from(tree.querySelectorAll('[data-testid="den-thread-icon"]')).map((i) => i.getAttribute("data-kind"));
		assert.deepEqual(kinds, ["home", "feature"]);
		const group = q('[data-thread="hal/b"]')!.closest('[data-testid="den-thread-group"]')!;
		assert.equal(group.querySelectorAll('[data-testid="den-row"]').length, 1, "the card sits under its thread");
		assert.equal(q('[data-thread="hal/b"]')!.querySelector('[data-testid="den-thread-count"]')?.textContent, "1");
	});

	it("a thread row's icon buttons: the eye is disabled with no visualizations, open-page goes to the thread page", async () => {
		await mount();
		await click(wolf("hal"));
		const b = q('[data-thread="hal/b"]')!.closest('[data-testid="den-thread-group"]')!;
		assert.equal(b.querySelector('[data-testid="den-thread-viz"]')?.hasAttribute("disabled"), true);
		await click(b.querySelector<HTMLElement>('[data-testid="den-thread-open"]')!);
		await flush();
		assert.equal(navLog.stack[navLog.index], "/wolf/hal/thread/b");
		assert.equal(q('[data-testid="den-sheet"]'), null, "the tree collapses");
	});

	it("the bar header's wolf name opens the same tree for the attached wolf", async () => {
		await mount();
		await click(q('[data-testid="chat-bar-chip"]')!);
		assert.equal(q('[data-testid="den-sheet"]')?.getAttribute("aria-label"), "w: switch thread");
		assert.equal(q('[data-testid="den-thread"][aria-current="true"]')?.getAttribute("data-thread"), "w/a", "the attached thread is highlighted");
	});

	it("over another thread's page the attached wolf's button is the swap control: a click docks the page's thread without opening the sheet, and no Swap pill is drawn", async () => {
		await mount("/wolf/hal/thread/b");
		assert.equal(q('[data-testid="chat-bar-swap-wrap"]'), null);
		const sw = q('[data-testid="chat-bar-swap"]')!;
		assert.equal(sw.getAttribute("data-wolf"), "w");
		assert.equal(sw.getAttribute("aria-label"), "Answer hal/b", "hal/b waits on the owner, so the control says Answer");
		assert.equal(wolf("hal").getAttribute("data-swap"), null, "only the attached wolf swaps");
		await click(sw);
		await flush();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "hal/b");
		assert.equal(q('[data-testid="den-sheet"]'), null, "the sheet never opened");
	});

	it("hovering another wolf puts the swap icon on that wolf's button, not the attached wolf's, and leaving restores it", async () => {
		await mount("/wolf/hal/thread/b");
		const fire = (el: HTMLElement, name: string) => act(async () => void props(el, name)({ currentTarget: el, target: el }));
		const icon = '[data-testid="den-swap-icon"]';
		assert.ok(q(`[data-testid="chat-bar-swap"][data-wolf="w"] ${icon}`), "the attached wolf wears it at rest");
		await fire(wolf("hal"), "onMouseEnter");
		assert.ok(q(`[data-testid="den-wolf"][data-wolf="hal"] ${icon}`), "the hovered wolf wears it");
		assert.equal(q(`[data-testid="chat-bar-swap"][data-wolf="w"] ${icon}`), null, "the attached wolf does not");
		assert.equal(document.querySelectorAll(icon).length, 1);
		await fire(wolf("hal"), "onMouseLeave");
		assert.ok(q(`[data-testid="chat-bar-swap"][data-wolf="w"] ${icon}`), "back on the attached wolf");
		assert.equal(q(`[data-testid="den-wolf"][data-wolf="hal"] ${icon}`), null);
	});

	it("clicking the swap icon on a hovered wolf attaches the chat to that wolf's home thread and opens no tree", async () => {
		await mount("/wolf/hal/thread/b");
		const fire = (el: HTMLElement, name: string) => act(async () => void props(el, name)({ currentTarget: el, target: el }));
		await fire(wolf("hal"), "onMouseEnter");
		await click(wolf("hal"));
		await flush();
		const a = JSON.parse(mem.get(ATTACHED_KEY)!);
		assert.deepEqual([a.wolf, a.threadId], ["hal", "hal/home"]);
		assert.equal(q('[data-testid="den-sheet"]'), null, "no tree opened");
	});
});
