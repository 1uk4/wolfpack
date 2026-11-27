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
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }, { name: "hal" }] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [th("w/home", { kind: "home", status: "busy" }), th("w/a")] });
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

async function mount() {
	mem.set(ATTACHED_KEY, JSON.stringify({ wolf: "w", slug: "a", threadId: "w/a" }));
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start="/kb">
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
		assert.equal(q('[data-testid="den-sheet"]')?.getAttribute("aria-label"), "hal needs you");
		assert.match(q('[data-testid="den-row"]')!.textContent ?? "", /Sync worker.*Restart the sync worker\?/);
		await act(async () => void document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key: "Escape" })));
		assert.equal(q('[data-testid="den-sheet"]'), null, "Esc closes");
		await click(wolf("hal"));
		assert.ok(q('[data-testid="den-sheet"]'));
		await click(wolf("hal"));
		assert.equal(q('[data-testid="den-sheet"]'), null, "a second click closes");
	});

	it("a row opens its thread and closes the sheet", async () => {
		await mount();
		await click(wolf("hal"));
		await until(() => q('[data-testid="den-row"] a'), "the row");
		await click(q('[data-testid="den-row"] a')!);
		assert.equal(navLog.stack[navLog.index], "/wolf/hal/thread/b");
		assert.equal(q('[data-testid="den-sheet"]'), null);
	});
});
