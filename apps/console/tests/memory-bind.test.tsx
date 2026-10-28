/** The Status panel's bind button: its state belongs to the task it was pressed on; a double click sends one request. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	self: globalThis,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
	localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

const { MemoryPanel } = await import("../components/memory-panel.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");

const rec = (id: string) => ({ id, title: `Title ${id}`, kind: "task", stage: "plan", domain: "d", plan: "", record: "", dependsOn: [], children: [] });
const realFetch = globalThis.fetch;
let binds = 0;
let release: () => void = () => {};
let bindReply: () => Promise<Response> = async () => new Response(JSON.stringify({ error: "x" }), { status: 409 });
function stubFetch() {
	binds = 0;
	globalThis.fetch = (async (url: string, init?: { method?: string }) => {
		const u = String(url);
		if (u.endsWith("/bind")) {
			binds++;
			return bindReply();
		}
		if (u.endsWith("/memory/observations")) return new Response(JSON.stringify({ observations: [], total: 0 }), { status: 200 });
		const m = /\/work\/([^/]+)\/record/.exec(u);
		if (m) return new Response(JSON.stringify(rec(decodeURIComponent(m[1]!))), { status: 200 });
		void init;
		return new Response(JSON.stringify({ state: "live", reason: "", bound: { workId: "bound-1", title: "Bound" }, pool: null, sessionTopics: [], denTopics: [] }), { status: 200 });
	}) as never;
}
let root: Root | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	globalThis.fetch = realFetch;
});
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const quiet = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });
async function mount(taskId: string, nonce: number) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const ui = (id: string, n: number) => (
		<MemoryEventsProvider connect={quiet}>
			<MemoryPanel embedded wolf="w" threadId="t1" slug="s1" selectTaskId={id} selectNonce={n} />
		</MemoryEventsProvider>
	);
	await act(async () => root!.render(ui(taskId, nonce)));
	await settle();
	return (id: string, n: number) => act(async () => root!.render(ui(id, n)));
}
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));

describe("Status panel bind button", () => {
	it("a refusal stays on its own task: another task shows no error, going back shows it again", async () => {
		stubFetch();
		const show = await mount("task-a", 1);
		await click(q('[data-testid="memory-bind-button"]')!);
		await settle();
		assert.ok((q('[data-testid="memory-bind-error"]')?.textContent ?? "") === "x");
		await show("task-b", 2);
		await settle();
		assert.ok(q('[data-testid="memory-bind-button"]') !== null, "offered on the other task");
		assert.ok(q('[data-testid="memory-bind-error"]') === null, "no error on another task");
		await show("task-a", 3);
		await settle();
		assert.ok((q('[data-testid="memory-bind-error"]')?.textContent ?? "") === "x");
	});
	it("a non-string error shows a generic message", async () => {
		stubFetch();
		bindReply = async () => new Response(JSON.stringify({ error: { code: 1 } }), { status: 500 });
		await mount("task-a", 1);
		await click(q('[data-testid="memory-bind-button"]')!);
		await settle();
		assert.ok((q('[data-testid="memory-bind-error"]')?.textContent ?? "") === "Could not bind (500).");
	});
	it("a double click sends one request", async () => {
		stubFetch();
		bindReply = () => new Promise<Response>((res) => void (release = () => res(new Response("{}", { status: 200 }))));
		await mount("task-a", 1);
		const btn = q('[data-testid="memory-bind-button"]')!;
		await act(async () => {
			btn.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
			btn.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
		});
		assert.equal(binds, 1);
		release();
		await settle();
		assert.equal(binds, 1);
	});
});
